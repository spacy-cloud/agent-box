import { fireEvent, screen, within } from '@testing-library/react';

/**
 * The control of a table row that does `name`: a visible button, or - when the action moved into the "⋯" menu
 * of the row - its menu item (the menu is opened on the way). Same idea as `rowAction` in the e2e helpers.
 */
export function rowAction(row: HTMLElement, name: string | RegExp): HTMLElement {
  const direct = within(row).queryByRole('button', { name });
  if (direct) return direct;
  fireEvent.click(within(row).getByRole('button', { name: /^(Weitere Aktionen|More actions)/ }));
  return screen.getByRole('menuitem', { name });
}
