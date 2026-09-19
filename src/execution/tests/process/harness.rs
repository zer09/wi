use super::Fixture;
use std::{
    fs,
    io::{BufRead, Read, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

pub(super) fn private_dir(path: &Path) {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).unwrap();
}

// Follow storage::process_tests: explicit stdin, cleared environment, drained pipes and reaping.
pub(crate) struct Process {
    child: Child,
    ready: mpsc::Receiver<()>,
    stdout: Option<thread::JoinHandle<String>>,
    stderr: Option<thread::JoinHandle<String>>,
}
impl Process {
    pub(super) fn start(sandbox: &Path, fixture: &Fixture) -> Self {
        Self::start_test(
            sandbox,
            fixture,
            "execution::tests::process::execution_child",
        )
    }
    pub fn start_test(sandbox: &Path, fixture: &impl serde::Serialize, helper: &str) -> Self {
        for name in ["home", "xdg", "codex", "tmp"] {
            private_dir(&sandbox.join(name));
        }
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", helper, "--ignored", "--nocapture"])
            .current_dir(sandbox)
            .env_clear()
            .env("HOME", sandbox.join("home"))
            .env("XDG_CONFIG_HOME", sandbox.join("xdg"))
            .env("CODEX_HOME", sandbox.join("codex"))
            .env("TMPDIR", sandbox.join("tmp"))
            .env("TEMP", sandbox.join("tmp"))
            .env("TMP", sandbox.join("tmp"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().unwrap();
        writeln!(
            child.stdin.as_mut().unwrap(),
            "{}",
            serde_json::to_string(fixture).unwrap()
        )
        .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (notify, ready) = mpsc::channel();
        let stdout = thread::spawn(move || {
            let mut text = String::new();
            for line in std::io::BufReader::new(stdout).lines() {
                let line = line.unwrap();
                if line == "READY" {
                    let _ = notify.send(());
                }
                text.push_str(&line);
                text.push('\n');
            }
            text
        });
        let mut stderr = child.stderr.take().unwrap();
        let stderr = thread::spawn(move || {
            let mut text = String::new();
            stderr.read_to_string(&mut text).unwrap();
            text
        });
        Self {
            child,
            ready,
            stdout: Some(stdout),
            stderr: Some(stderr),
        }
    }
    pub fn ready(&self) {
        self.ready
            .recv_timeout(Duration::from_secs(20))
            .expect("child readiness watchdog");
    }
    pub fn release(&mut self) {
        writeln!(self.child.stdin.as_mut().unwrap(), "release").unwrap();
    }
    pub fn finish(mut self, code: i32) {
        let start = Instant::now();
        let status = loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                break status;
            }
            assert!(
                start.elapsed() < Duration::from_secs(20),
                "child exit watchdog, not rollback evidence"
            );
            thread::sleep(Duration::from_millis(5));
        };
        let stdout = self.stdout.take().unwrap().join().unwrap();
        let stderr = self.stderr.take().unwrap().join().unwrap();
        assert_eq!(
            status.code(),
            Some(code),
            "child stdout: {stdout}\nchild stderr: {stderr}"
        );
        for line in stdout.lines().filter(|line| line.starts_with("PROOF ")) {
            println!("{line}; exit={code}");
        }
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        // The owning parent's TempDir outlives this guard, including on assertion failure.
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(stdout) = self.stdout.take() {
            let _ = stdout.join();
        }
        if let Some(stderr) = self.stderr.take() {
            let _ = stderr.join();
        }
    }
}

pub(in crate::execution::tests) fn release_from_parent(input: &mut impl BufRead) {
    println!("READY");
    std::io::stdout().flush().unwrap();
    let mut line = String::new();
    input.read_line(&mut line).unwrap();
    assert_eq!(line.trim(), "release");
}
