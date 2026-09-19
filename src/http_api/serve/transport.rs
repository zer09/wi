use std::{
    future::{Future, pending},
    io,
    net::SocketAddr,
    pin::Pin,
    sync::{Arc, OnceLock},
    task::{Context, Poll},
};

use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
    sync::watch,
};
use tokio_util::sync::{CancellationToken, WaitForCancellationFutureOwned};

use super::ServeError;

pub(super) struct ClosingListener {
    pub listener: TcpListener,
    pub network_close: CancellationToken,
    pub failure: Arc<OnceLock<ServeError>>,
    pub sockets: watch::Receiver<()>,
    #[cfg(test)]
    pub hooks: Arc<super::tests::Hooks>,
}

impl axum::serve::Listener for ClosingListener {
    type Io = ClosingIo;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        let accept = self.listener.accept();
        #[cfg(test)]
        let accept = async {
            tokio::select! {
                biased;
                fault = self.hooks.fault() => match fault {
                    super::tests::Fault::Accept => Err(io::ErrorKind::Other.into()),
                    super::tests::Fault::Panic => panic!("synthetic serving unwind"),
                },
                accepted = accept => accepted,
            }
        };
        let accepted = tokio::select! {
            biased;
            _ = self.network_close.cancelled() => pending().await,
            accepted = accept => accepted,
        };
        match accepted {
            Ok((stream, address)) => {
                #[cfg(test)]
                self.hooks.accepted.notify_one();
                (
                    ClosingIo {
                        stream,
                        // Keep separate waiters so split read/write polls cannot replace each
                        // other's cancellation waker. Allocate once per socket, never per byte.
                        read_close: Box::pin(self.network_close.clone().cancelled_owned()),
                        write_close: Box::pin(self.network_close.clone().cancelled_owned()),
                        _socket: self.sockets.clone(),
                        #[cfg(test)]
                        hooks: self.hooks.clone(),
                    },
                    address,
                )
            }
            Err(_) => {
                let _ = self.failure.set(ServeError::Accept);
                self.network_close.cancel();
                // Axum's Listener cannot return errors. Its shutdown signal exits accept;
                // retain the static failure for the owner instead of retrying or spinning.
                pending().await
            }
        }
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        self.listener.local_addr()
    }
}

pub(super) struct ClosingIo {
    stream: TcpStream,
    read_close: Pin<Box<WaitForCancellationFutureOwned>>,
    write_close: Pin<Box<WaitForCancellationFutureOwned>>,
    _socket: watch::Receiver<()>,
    #[cfg(test)]
    hooks: Arc<super::tests::Hooks>,
}

impl AsyncRead for ClosingIo {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.read_close.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(io::ErrorKind::ConnectionAborted.into()));
        }
        Pin::new(&mut self.stream).poll_read(cx, buffer)
    }
}

impl AsyncWrite for ClosingIo {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.write_close.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(io::ErrorKind::ConnectionAborted.into()));
        }
        let result = Pin::new(&mut self.stream).poll_write(cx, buffer);
        #[cfg(test)]
        {
            use std::sync::atomic::Ordering;
            if let Poll::Ready(Ok(bytes)) = result {
                self.hooks.written.fetch_add(bytes, Ordering::SeqCst);
            }
            if result.is_pending() && self.hooks.written.load(Ordering::SeqCst) > 1024 * 1024 {
                self.hooks.write_pending.notify_one();
            }
        }
        result
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if self.write_close.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(io::ErrorKind::ConnectionAborted.into()));
        }
        Pin::new(&mut self.stream).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if self.write_close.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}
