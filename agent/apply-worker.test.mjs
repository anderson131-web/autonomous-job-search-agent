import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { detectVendor, fillKnownFields, collectUnhandledFields } from './apply-worker.mjs';

// Regression test for a real bug caught by manually running the pipeline
// end-to-end: fillKnownFields() called labelFor(page, input) — one argument
// too many — so every field silently went unfilled while reporting success.
// No prior test exercised a live browser fill, so it shipped unnoticed.

const TEST_FORM = `<!doctype html><html><body>
<input type="text" name="full_name" placeholder="Full Name">
<input type="email" name="email" placeholder="Email">
<input type="tel" name="phone" placeholder="Phone">
<input type="text" name="linkedin" placeholder="LinkedIn">
<input type="text" name="portfolio" placeholder="Portfolio">
<textarea name="cover_letter"></textarea>
<select name="work_auth"><option>Yes</option><option>No</option></select>
</body></html>`;

const candidate = {
  fullName: 'Anderson Abraham',
  email: 'andersonabraham2131@gmail.com',
  phone: '+1-331-328-8244',
  linkedin: 'linkedin.com/in/anderson-abraham',
  portfolioUrl: 'https://anderson-abraham.com',
};

function tmpFormFile() {
  const dir = mkdtempSync(path.join(tmpdir(), 'apply-worker-test-'));
  const file = path.join(dir, 'form.html');
  writeFileSync(file, TEST_FORM);
  return { dir, file };
}

test('detectVendor recognizes each supported ATS and flags LinkedIn/unknown correctly', () => {
  assert.equal(detectVendor('https://job-boards.greenhouse.io/acme/jobs/1'), 'greenhouse');
  assert.equal(detectVendor('https://jobs.lever.co/acme/1'), 'lever');
  assert.equal(detectVendor('https://jobs.ashbyhq.com/acme/1'), 'ashby');
  assert.equal(detectVendor('https://www.linkedin.com/jobs/view/123/'), 'linkedin');
  assert.equal(detectVendor('https://www.ziprecruiter.com/job-redirect?x=1'), 'unknown');
  assert.equal(detectVendor('not a url'), null);
});

test('fillKnownFields actually fills every high-confidence field with the real candidate values', async () => {
  const { dir, file } = tmpFormFile();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('file://' + file.replace(/\\/g, '/'));
    const result = { filledFields: [], needsConfirmation: [] };
    await fillKnownFields(page, candidate, result);

    assert.deepEqual(
      result.filledFields.sort(),
      ['email', 'fullName', 'linkedin', 'phone', 'portfolio'].sort(),
    );
    assert.equal(await page.locator('input[name="full_name"]').inputValue(), 'Anderson Abraham');
    assert.equal(await page.locator('input[name="email"]').inputValue(), candidate.email);
    assert.equal(await page.locator('input[name="phone"]').inputValue(), candidate.phone);
    assert.match(await page.locator('input[name="linkedin"]').inputValue(), /^https:\/\//);
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collectUnhandledFields flags the textarea and select as needing candidate confirmation', async () => {
  const { dir, file } = tmpFormFile();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('file://' + file.replace(/\\/g, '/'));
    const result = { filledFields: [], needsConfirmation: [] };
    await collectUnhandledFields(page, result);

    // labelFor() falls back to the raw `name` attribute when there's no
    // aria-label/placeholder — it doesn't prettify it, so this is the
    // literal value a real posting's field name would produce too.
    const questions = result.needsConfirmation.map((q) => q.question);
    assert.ok(questions.includes('cover_letter'));
    assert.ok(questions.includes('work_auth'));
    assert.equal(result.needsConfirmation.find((q) => q.question === 'cover_letter').fieldType, 'textarea');
    assert.equal(result.needsConfirmation.find((q) => q.question === 'work_auth').fieldType, 'select');
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
