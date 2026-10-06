// Test the ACTUAL shared renderer, compiling its declarations with the existing
// TypeScript dependency. No network, fixtures or additional packages needed.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const source = fs.readFileSync(path.join(__dirname, '../src/components/ChatTabParts.tsx'), 'utf8')
const start = source.indexOf('export function renderInline(')
const end = source.indexOf('// Strip the agent', start)
assert(start >= 0 && end > start, 'shared renderer declarations not found')
const compiled = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const exported = {}
// The copy button icon is unrelated to Markdown; supply it when rendering code.
new Function('require', 'exports', 'useState', 'useCallback', 'CopyIcon', compiled)(require, exported, React.useState, React.useCallback, () => null)
const inline = text => renderToStaticMarkup(React.createElement(React.Fragment, null, exported.renderInline(text, 'test')))
const blocks = text => renderToStaticMarkup(React.createElement(React.Fragment, null, exported.renderBlocks(text)))
const plain = '[Cheburcheck](https://cheburcheck.ru/)'
const escaped = String.raw`\[Cheburcheck\](https://cheburcheck.ru/)`
for (const text of [plain, escaped, String.raw`\[Cheburcheck\]\(https://cheburcheck.ru/\)`]) {
  const html = inline('ПРИМЕР ' + text)
  assert.match(html, /href="https:\/\/cheburcheck\.ru\/"/)
  assert.match(html, />Cheburcheck<\/a>/)
  assert(!html.includes('\\'), 'escape delimiters leaked into visible text')
  assert.match(html, /rel="noopener noreferrer"/)
}
assert.equal(inline(plain + ' ' + escaped).match(/<a /g).length, 2)
assert.match(inline('[**Cheburcheck**](https://cheburcheck.ru/)'), /<a [^>]+><strong/)
for (const text of ['# ' + escaped, '- ' + escaped, '1. ' + escaped, '| Site |\n| --- |\n| ' + escaped + ' |']) {
  assert.match(blocks(text), /href="https:\/\/cheburcheck\.ru\/"/)
}
assert(!inline('`' + escaped + '`').includes('<a '), 'inline code turned into a link')
assert(!blocks('```md\n' + escaped + '\n```').includes('<a '), 'fenced code turned into a link')
assert.equal(inline(String.raw`unrelated \[brackets\]`), String.raw`unrelated \[brackets\]`)
for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,evil']) {
  assert(!inline('[Bad](' + url + ')').includes('<a '), 'unsafe protocol became clickable')
}
assert.match(inline('[Email](mailto:test@example.invalid)'), /href="mailto:test@example.invalid"/)
assert.match(inline('**bold** and *italic*'), /<strong/)
assert.match(inline('**bold** and *italic*'), /<em/)
console.log('Markdown links: plain/escaped, labels, headings, lists, tables, code and unsafe protocols: PASS')
