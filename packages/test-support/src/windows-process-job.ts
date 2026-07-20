import koffi from "koffi";

const JOB_OBJECT_ASSIGN_PROCESS = 0x0001;
const JOB_OBJECT_QUERY = 0x0004;
const JOB_OBJECT_TERMINATE = 0x0008;
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION_CLASS = 1;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;

const kernel32 = koffi.load("kernel32.dll");
// Koffi keeps named types in a process-global registry. Vitest reloads this module
// for isolated files, so anonymous descriptors prevent duplicate registrations.
const Handle = koffi.pointer(koffi.opaque());
const JobBasicLimit = koffi.struct({
  PerProcessUserTimeLimit: "int64",
  PerJobUserTimeLimit: "int64",
  LimitFlags: "uint32",
  MinimumWorkingSetSize: "size_t",
  MaximumWorkingSetSize: "size_t",
  ActiveProcessLimit: "uint32",
  Affinity: "uintptr",
  PriorityClass: "uint32",
  SchedulingClass: "uint32",
});
const IoCounters = koffi.struct({
  ReadOperationCount: "uint64",
  WriteOperationCount: "uint64",
  OtherOperationCount: "uint64",
  ReadTransferCount: "uint64",
  WriteTransferCount: "uint64",
  OtherTransferCount: "uint64",
});
const JobExtendedLimit = koffi.struct({
  BasicLimitInformation: JobBasicLimit,
  IoInfo: IoCounters,
  ProcessMemoryLimit: "size_t",
  JobMemoryLimit: "size_t",
  PeakProcessMemoryUsed: "size_t",
  PeakJobMemoryUsed: "size_t",
});
const JobAccounting = koffi.struct({
  TotalUserTime: "int64",
  TotalKernelTime: "int64",
  ThisPeriodTotalUserTime: "int64",
  ThisPeriodTotalKernelTime: "int64",
  TotalPageFaultCount: "uint32",
  TotalProcesses: "uint32",
  ActiveProcesses: "uint32",
  TotalTerminatedProcesses: "uint32",
});

const CreateJobObjectW = kernel32.func(
  "__stdcall",
  "CreateJobObjectW",
  Handle,
  ["void *", "str16"],
) as (attributes: null, name: string) => bigint | null;
const OpenJobObjectW = kernel32.func(
  "__stdcall",
  "OpenJobObjectW",
  Handle,
  ["uint32", "int", "str16"],
) as (access: number, inherit: number, name: string) => bigint | null;
const GetCurrentProcess = kernel32.func(
  "__stdcall",
  "GetCurrentProcess",
  Handle,
  [],
) as () => bigint;
const AssignProcessToJobObject = kernel32.func(
  "__stdcall",
  "AssignProcessToJobObject",
  "int",
  [Handle, Handle],
) as (job: bigint, process: bigint) => number;
const QueryInformationJobObject = kernel32.func(
  "__stdcall",
  "QueryInformationJobObject",
  "int",
  [Handle, "int", koffi.out(koffi.pointer(JobAccounting)), "uint32", "void *"],
) as (
  job: bigint,
  informationClass: number,
  information: JobAccountingInformation,
  informationLength: number,
  returnLength: null,
) => number;
const SetInformationJobObject = kernel32.func(
  "__stdcall",
  "SetInformationJobObject",
  "int",
  [Handle, "int", koffi.pointer(JobExtendedLimit), "uint32"],
) as (
  job: bigint,
  informationClass: number,
  information: JobExtendedLimitInformation,
  informationLength: number,
) => number;
const TerminateJobObject = kernel32.func(
  "__stdcall",
  "TerminateJobObject",
  "int",
  [Handle, "uint32"],
) as (job: bigint, exitCode: number) => number;
const CloseHandle = kernel32.func(
  "__stdcall",
  "CloseHandle",
  "int",
  [Handle],
) as (handle: bigint) => number;
const GetLastError = kernel32.func(
  "__stdcall",
  "GetLastError",
  "uint32",
  [],
) as () => number;

interface JobExtendedLimitInformation {
  readonly BasicLimitInformation: {
    readonly PerProcessUserTimeLimit: bigint;
    readonly PerJobUserTimeLimit: bigint;
    readonly LimitFlags: number;
    readonly MinimumWorkingSetSize: number;
    readonly MaximumWorkingSetSize: number;
    readonly ActiveProcessLimit: number;
    readonly Affinity: number;
    readonly PriorityClass: number;
    readonly SchedulingClass: number;
  };
  readonly IoInfo: {
    readonly ReadOperationCount: bigint;
    readonly WriteOperationCount: bigint;
    readonly OtherOperationCount: bigint;
    readonly ReadTransferCount: bigint;
    readonly WriteTransferCount: bigint;
    readonly OtherTransferCount: bigint;
  };
  readonly ProcessMemoryLimit: number;
  readonly JobMemoryLimit: number;
  readonly PeakProcessMemoryUsed: number;
  readonly PeakJobMemoryUsed: number;
}

interface JobAccountingInformation {
  TotalUserTime?: bigint;
  TotalKernelTime?: bigint;
  ThisPeriodTotalUserTime?: bigint;
  ThisPeriodTotalKernelTime?: bigint;
  TotalPageFaultCount?: number;
  TotalProcesses?: number;
  ActiveProcesses?: number;
  TotalTerminatedProcesses?: number;
}

function windowsFailure(operation: string): Error {
  return new Error(`${operation} failed with Windows error ${String(GetLastError())}`);
}

function enableKillOnJobClose(handle: bigint): void {
  const information: JobExtendedLimitInformation = {
    BasicLimitInformation: {
      PerProcessUserTimeLimit: 0n,
      PerJobUserTimeLimit: 0n,
      LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
      MinimumWorkingSetSize: 0,
      MaximumWorkingSetSize: 0,
      ActiveProcessLimit: 0,
      Affinity: 0,
      PriorityClass: 0,
      SchedulingClass: 0,
    },
    IoInfo: {
      ReadOperationCount: 0n,
      WriteOperationCount: 0n,
      OtherOperationCount: 0n,
      ReadTransferCount: 0n,
      WriteTransferCount: 0n,
      OtherTransferCount: 0n,
    },
    ProcessMemoryLimit: 0,
    JobMemoryLimit: 0,
    PeakProcessMemoryUsed: 0,
    PeakJobMemoryUsed: 0,
  };
  if (
    SetInformationJobObject(
      handle,
      JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
      information,
      koffi.sizeof(JobExtendedLimit),
    ) === 0
  ) {
    throw windowsFailure("SetInformationJobObject");
  }
}

export class WindowsProcessJob {
  private closed = false;

  private constructor(
    readonly name: string,
    private readonly handle: bigint,
  ) {}

  static create(name: string): WindowsProcessJob {
    const handle = CreateJobObjectW(null, name);
    if (handle === null || handle === 0n) throw windowsFailure("CreateJobObjectW");
    try {
      // If the harness owner dies, closing its last handle must still reclaim every fixture.
      enableKillOnJobClose(handle);
      return new WindowsProcessJob(name, handle);
    } catch (error) {
      CloseHandle(handle);
      throw error;
    }
  }

  activeProcessCount(): number {
    if (this.closed) return 0;
    const information: JobAccountingInformation = {};
    if (
      QueryInformationJobObject(
        this.handle,
        JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION_CLASS,
        information,
        koffi.sizeof(JobAccounting),
        null,
      ) === 0
    ) {
      throw windowsFailure("QueryInformationJobObject");
    }
    const count = information.ActiveProcesses;
    if (count === undefined) throw new Error("Windows Job Object returned no active process count");
    return count;
  }

  terminate(): void {
    if (this.closed || this.activeProcessCount() === 0) return;
    if (TerminateJobObject(this.handle, 1) === 0) throw windowsFailure("TerminateJobObject");
  }

  close(): void {
    if (this.closed) return;
    if (CloseHandle(this.handle) === 0) throw windowsFailure("CloseHandle");
    this.closed = true;
  }
}

export function assignCurrentProcessToWindowsJob(name: string): void {
  const handle = OpenJobObjectW(
    JOB_OBJECT_ASSIGN_PROCESS | JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE,
    0,
    name,
  );
  if (handle === null || handle === 0n) throw windowsFailure("OpenJobObjectW");
  const assigned = AssignProcessToJobObject(handle, GetCurrentProcess());
  const assignmentError = assigned === 0
    ? windowsFailure("AssignProcessToJobObject")
    : null;
  const closed = CloseHandle(handle);
  if (assignmentError !== null) throw assignmentError;
  if (closed === 0) throw windowsFailure("CloseHandle");
}
