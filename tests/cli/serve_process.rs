use std::{
    fs,
    io::BufRead,
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

// Test processes get unusable synthetic auth roots, never the owner's environment.
pub fn isolated(command: &mut Command, sandbox: &Path) {
    for name in ["home", "xdg", "codex"] {
        fs::write(sandbox.join(name), "private-auth-canary").unwrap();
    }
    command
        .current_dir(sandbox)
        .env_clear()
        .env("HOME", sandbox.join("home"))
        .env("USERPROFILE", sandbox.join("home"))
        .env("XDG_CONFIG_HOME", sandbox.join("xdg"))
        .env("CODEX_HOME", sandbox.join("codex"))
        .env("TMPDIR", sandbox)
        .env("TEMP", sandbox)
        .env("TMP", sandbox);
}

pub struct Process {
    pub child: Child,
    lines: mpsc::Receiver<String>,
    readers: Vec<thread::JoinHandle<String>>,
}
impl Process {
    pub fn start(mut command: Command, sandbox: &Path) -> Self {
        isolated(&mut command, sandbox);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let (sender, lines) = mpsc::channel();
        let pipes: Vec<Box<dyn std::io::Read + Send>> = vec![
            Box::new(child.stdout.take().unwrap()),
            Box::new(child.stderr.take().unwrap()),
        ];
        let readers = pipes
            .into_iter()
            .map(|pipe| {
                let sender = sender.clone();
                thread::spawn(move || {
                    let mut captured = String::new();
                    for line in std::io::BufReader::new(pipe).lines() {
                        let line = line.unwrap();
                        let _ = sender.send(line.clone());
                        captured.push_str(&line);
                        captured.push('\n');
                    }
                    captured
                })
            })
            .collect();
        Self {
            child,
            lines,
            readers,
        }
    }
    pub fn line(&self, prefix: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let line = self
                .lines
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("child message watchdog");
            if let Some(value) = line.strip_prefix(prefix) {
                return value.to_owned();
            }
        }
    }
    pub fn finish(mut self, code: i32) -> (String, String) {
        let start = Instant::now();
        let status = loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                break status;
            }
            assert!(
                start.elapsed() < Duration::from_secs(30),
                "child exit watchdog"
            );
            thread::sleep(Duration::from_millis(5));
        };
        let mut output = self.readers.drain(..).map(|reader| reader.join().unwrap());
        let stdout = output.next().unwrap();
        let stderr = output.next().unwrap();
        assert_eq!(
            status.code(),
            Some(code),
            "stdout: {stdout}\nstderr: {stderr}"
        );
        (stdout, stderr)
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        for reader in self.readers.drain(..) {
            let _ = reader.join();
        }
    }
}
