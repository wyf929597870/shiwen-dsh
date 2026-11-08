import assert from 'node:assert/strict';
import test from 'node:test';
import {renderMarkdownHtml,attachmentImageIds} from '../web/markdown-renderer.mjs';

test('finds image references without treating code examples as attachments',()=>{
 const id='12345678-1234-4123-8123-123456789abc',other='87654321-4321-4321-8321-123456789abc';
 assert.deepEqual([...attachmentImageIds(`![x](attachment:${id})\n\n![[attachment:${other}|old]]\n\n\`![x](attachment:ignored)\`\n\n\`\`\`\n![x](attachment:ignored)\n\`\`\``)],[id,other]);
});

test('renders common Markdown blocks and tables', () => {
  const html = renderMarkdownHtml([
    '# Heading', '', '- one', '- two', '', '> quoted', '',
    '```js', 'const x = 1;', '```', '', '| A | B |', '| - | - |', '| 1 | 2 |'
  ].join('\n'));
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<ul>[\s\S]*<li>one<\/li>[\s\S]*<li>two<\/li>/);
  assert.match(html, /<blockquote>[\s\S]*quoted[\s\S]*<\/blockquote>/);
  assert.match(html, /<pre><code class="language-js">const x = 1;/);
  assert.match(html, /<div class="md-table"><table>/);
  assert.match(html, /<td>2<\/td>[\s\S]*<\/table><\/div>/);
});

test('escapes raw HTML and rejects unsafe link schemes', () => {
  const html = renderMarkdownHtml('<img src=x onerror=alert(1)>\n\n[unsafe](javascript:alert%281%29) [safe](https://example.org)');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img\b|href="javascript:/i);
  assert.match(html, /href="https:\/\/example\.org" target="_blank" rel="noopener noreferrer"/);
});

test('renders remote images as escaped opt-in buttons', () => {
  const html = renderMarkdownHtml('![<script>alert(1)</script>](https://example.org/image.png)');
  assert.match(html, /class="md-network-image"/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img\b|src="https:\/\/example\.org\/image\.png"|<script>/i);
  assert.match(renderMarkdownHtml('![Photo](https://example.org/a.png)','en'),/Load remote image/);
});

test('keeps imported relative image targets for scoped native resolution', () => {
 const html=renderMarkdownHtml('![图](../assets/a.png)\n\n![[assets/b.png|说明]]');
 assert.match(html,/data-image-target="\.\.\/assets\/a\.png"/);
 assert.match(html,/data-image-target="assets\/b\.png"/);
 assert.doesNotMatch(html,/<img\b/);
});

test('marks only bounded attachment references for native loading', () => {
  const html = renderMarkdownHtml('![Local](attachment:attachment-123) ![Remote](https://example.org/photo.png)');
  assert.match(html, /class="md-attachment-pending" data-attachment-id="attachment-123"/);
  assert.match(html, /data-image-url="https:\/\/example\.org\/photo\.png"/);
  assert.doesNotMatch(html, /<img\b/);
});
