/**
 * The complete tool surface. Deliberately absent: anything that changes policy, approves or denies,
 * manages hosts or tokens, touches other agents' sandboxes, runs commands on a host (`ssh_exec`) or writes
 * into the user's project (applying the changes of a sandbox is a human-only operation: GUI and `abox apply`).
 */
export const TOOL_NAMES = [
  'template_list',
  'template_show',
  'skill_list',
  'skill_show',
  'sandbox_create',
  'sandbox_list',
  'sandbox_inspect',
  'sandbox_start',
  'sandbox_exec',
  'sandbox_process_start',
  'sandbox_process_logs',
  'sandbox_process_stop',
  'sandbox_read_file',
  'sandbox_write_file',
  'sandbox_list_dir',
  'sandbox_network_log',
  'sandbox_snapshot',
  'sandbox_restore',
  'sandbox_export',
  'sandbox_stop',
  'sandbox_delete',
  'sandbox_port_forward',
  'access_request',
  'policy_show',
] as const;
