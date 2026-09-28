const fail = () => { throw new Error('fixture protocol rejected'); };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
  && value !== '00000000-0000-0000-0000-000000000000';
const sequence = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
  && BigInt(value) <= 9223372036854775807n;
function keys(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== fields.sort().join(',')) fail();
}
export function rotationRequest(value) {
  keys(value, ['command', 'id']);
  if (value.command !== 'rotate_account' || !Number.isSafeInteger(value.id) || value.id < 1 || value.id > 0xffffffff) fail();
  return value;
}
export function mismatchEvidence(value) {
  keys(value, ['protocol', 'id', 'event', 'exact', 'receipt', 'first_head', 'sequence_count', 'second_records',
    'run_state', 'code', 'result_recorded', 'history_unchanged', 'identity_checked', 'socket_closed', 'seed_head']);
  const receipt = value.receipt;
  keys(receipt, ['operation_id', 'session_id', 'run_id', 'first_sequence', 'last_sequence']);
  if (value.protocol !== 1 || value.event !== 'account_mismatch_inspect' || !Number.isSafeInteger(value.id) || value.id < 1 || value.id > 0xffffffff
    || ['exact', 'result_recorded', 'history_unchanged', 'identity_checked', 'socket_closed'].some(key => value[key] !== true)
    || value.run_state !== 'failed' || value.code !== 'history_identity' || value.second_records !== 6 || value.seed_head !== '1'
    || !sequence(value.first_head) || BigInt(value.first_head) < 6n || !sequence(value.sequence_count)
    || BigInt(value.sequence_count) !== BigInt(value.first_head) + 6n
    || ['operation_id', 'session_id', 'run_id'].some(key => !uuid(receipt[key]))
    || new Set([receipt.operation_id, receipt.session_id, receipt.run_id]).size !== 3
    || !sequence(receipt.first_sequence) || !sequence(receipt.last_sequence)
    || BigInt(receipt.first_sequence) !== BigInt(value.first_head) + 1n || BigInt(receipt.last_sequence) !== BigInt(value.first_head) + 2n) fail();
  return value;
}
export function accountMismatchProtocol(scenario) {
  let lastId = 0;
  let selecting;
  let selected;
  let fresh = new Set();
  let complete;
  let incompatible = false;
  let armedId;
  let acknowledged = false;
  const inspections = new Set();
  return {
    request(value) {
      if (!Number.isSafeInteger(value?.id) || value.id <= lastId || value.id > 0xffffffff) fail();
      if (armedId !== undefined && !['inspect', 'inspect_task', 'stop'].includes(value.command)) fail();
      if (['arm_acceptance', 'wait_acceptance', 'release_acceptance', 'arm_acceptance_unknown',
        'arm_acceptance_warning', 'seed_input_framing', 'replay_head'].includes(value.command)) incompatible = true;
      if (value.command === 'select') {
        if (selecting !== undefined || selected !== undefined || !fresh.has(value.session_id)) incompatible = true;
        selecting = { id: value.id, session: value.session_id };
      }
      if (value.command === 'inspect_task') inspections.add(value.id);
      if (value.command === 'rotate_account') {
        rotationRequest(value);
        if (scenario.mutations !== true || scenario.transport !== 'websocket' || scenario.recovered !== false || scenario.mime !== true
          || scenario.presentation === true || incompatible || selecting !== undefined || selected === undefined
          || complete?.receipt.session_id !== selected || armedId !== undefined) fail();
        armedId = value.id;
      }
      lastId = value.id;
    },
    reply(value) {
      if (value.event === 'mutation_inspect') fresh = new Set(value.creations.filter(entry => entry.exact && entry.sequence_count === '1')
        .map(entry => entry.receipt.session_id));
      if (value.event === 'selected' && selecting?.id === value.id) {
        selected = selecting.session; selecting = undefined;
      }
      if (value.event === 'task_inspect' && inspections.delete(value.id) && value.run_state === 'completed'
        && value.exact && value.receipt.session_id === selected) complete = value;
      if (value.event === 'account_rotated' || (armedId !== undefined && value.id === armedId)) {
        keys(value, ['protocol', 'event', 'id']);
        if (value.protocol !== 1 || value.event !== 'account_rotated' || value.id !== armedId || acknowledged) fail();
        acknowledged = true;
      }
      if (value.event === 'account_mismatch_inspect') {
        mismatchEvidence(value);
        if (!acknowledged || !inspections.delete(value.id) || value.receipt.session_id !== selected
          || value.first_head !== complete.sequence_count || value.receipt.run_id === complete.receipt.run_id
          || value.receipt.operation_id === complete.receipt.operation_id) fail();
      }
    },
  };
}
