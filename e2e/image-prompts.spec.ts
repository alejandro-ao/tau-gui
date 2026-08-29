import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { composer, launchApp } from './helpers.js';

const fixture = (name: string): string => join(process.cwd(), 'test', 'fixtures', 'images', name);

test('previews, removes, and submits multiple native image attachments', async () => {
  const handle = await launchApp({ settings: { agentRuntime: 'pi' } });
  try {
    await expect(handle.page.getByTestId('status-row')).toHaveAttribute('data-state', 'idle');
    await handle.page.evaluate(`(() => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.id = 'e2e-image-input';
      document.body.append(input);
    })()`);
    const input = handle.page.locator('#e2e-image-input');
    await input.setInputFiles([fixture('valid.png'), fixture('valid-2.png')]);
    await handle.page.evaluate(`(() => {
      const input = document.querySelector('#e2e-image-input');
      if (!input || !input.files) throw new Error('fixture input missing');
      const dataTransfer = new DataTransfer();
      for (const file of input.files) dataTransfer.items.add(file);
      window.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
    })()`);

    const attachments = handle.page.locator('.composer-attachment');
    await expect(attachments).toHaveCount(2);
    await expect(attachments.first().locator('img')).toHaveAttribute('src', /^data:image\//);
    await attachments.first().getByRole('button').click();
    await expect(attachments).toHaveCount(1);

    await composer(handle.page).fill('describe the attached image');
    await handle.page.keyboard.press('Enter');
    await expect(attachments).toHaveCount(0);
    await expect(
      handle.page.getByLabel('transcript').getByText('describe the attached image'),
    ).toBeVisible();
    await expect(handle.page.locator('body')).not.toContainText(fixture('valid.png'));
  } finally {
    await handle.close();
  }
});
