export class CancellationController {
  private readonly controller = new AbortController();
  private requested = false;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get cancelled(): boolean {
    return this.requested;
  }

  cancel(reason?: unknown): boolean {
    if (this.requested) return false;
    this.requested = true;
    this.controller.abort(reason);
    return true;
  }
}
