/**
 * The complete tool surface. Deliberately absent: anything that changes policy, approves or denies,
 * manages hosts or tokens, touches other agents' sandboxes or runs commands on a host (`ssh_exec`).
 */
export const TOOL_NAMES = [
  'template_list',
  'template_show',
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
  'sandbox_snapshot',
  'sandbox_restore',
  'sandbox_export',
  'sandbox_stop',
  'sandbox_delete',
  'access_request',
  'policy_show',
] as const;
