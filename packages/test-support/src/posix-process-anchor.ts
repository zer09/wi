// This process stays inside the fixture process group until watchdog cleanup.
// Its kernel-held group membership prevents the numeric PGID from being reused.
setInterval(() => undefined, 60_000);
