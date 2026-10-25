import { expect, type Page } from '@playwright/test';

/** Existing gameplay checks deliberately lay out the initially folded board. */
export async function openBoardIfNeeded(page: Page) {
  const table = page.getByRole('main', { name: 'Risk tabletop', exact: true });
  await expect(table).toHaveAttribute('data-board-state', /^(folded|opening|open|folding)$/);
  const state = await table.getAttribute('data-board-state');
  if (state === 'folded' || state === 'folding') {
    const primaryOpen = page.getByTestId('open-board-cta');
    if (state === 'folded' && await primaryOpen.isVisible()) await primaryOpen.click();
    else await page.getByRole('button', { name: 'Open board', exact: true }).click();
  }
  await expect(table).toHaveAttribute('data-board-state', 'open');
}
