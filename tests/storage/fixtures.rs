use std::{
    fs,
    path::{Path, PathBuf},
};

use sqlx::{ConnectOptions, Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use wi::storage::SessionStore;

pub(super) struct Fixture {
    pub temp: tempfile::TempDir,
    pub root: PathBuf,
}

impl Fixture {
    pub fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("synthetic-storage-canary");
        Self { temp, root }
    }

    #[cfg(unix)]
    pub fn short_unix() -> Self {
        // Unix socket paths are much shorter than normal filesystem paths on macOS.
        let temp = tempfile::Builder::new()
            .prefix("wi-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temp.path().join("r");
        Self { temp, root }
    }

    pub fn catalog(&self) -> PathBuf {
        self.root.join("catalog.sqlite3")
    }

    pub async fn initialized(&self) {
        SessionStore::open(self.root.clone())
            .await
            .unwrap()
            .close()
            .await
            .unwrap();
    }

    pub async fn independent_v1(&self) {
        directory(&self.root);
        file(&self.catalog(), b"");
        let mut connection = connect(&self.catalog()).await;
        sqlx::raw_sql(include_str!("catalog_v1.sql"))
            .execute(&mut connection)
            .await
            .unwrap();
        connection.close().await.unwrap();
    }

    pub async fn mutate(&self, sql: &'static str) {
        let mut connection = connect(&self.catalog()).await;
        sqlx::raw_sql(sql).execute(&mut connection).await.unwrap();
        connection.close().await.unwrap();
    }

    pub async fn assert_rejected_preserved(&self, code: &str) {
        let bytes = fs::read(self.catalog()).unwrap();
        let error = SessionStore::open(self.root.clone()).await.unwrap_err();
        assert_eq!(error.code(), code);
        assert_eq!(fs::read(self.catalog()).unwrap(), bytes);
        let diagnostic = format!("{error:?} {error}");
        assert!(!diagnostic.contains("synthetic-storage-canary"));
        assert!(!diagnostic.contains("synthetic-token-canary"));
        assert!(!diagnostic.contains("SELECT"));
    }
}

pub(super) fn directory(path: &Path) {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).unwrap();
}

pub(super) fn file(path: &Path, bytes: &[u8]) {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).unwrap().write_all(bytes).unwrap();
}

pub(super) async fn connect(path: &Path) -> SqliteConnection {
    SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .disable_statement_logging()
        .connect()
        .await
        .unwrap()
}
