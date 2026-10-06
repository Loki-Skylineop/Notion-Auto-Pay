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

// Regression: links wrapped in emphasis and repeatedly escaped by upstream text.
assert.match(inline('**' + escaped + '**'), /<strong[^>]*><a /)
assert.match(inline('*' + escaped + '*'), /<em><a /)
assert.match(inline(String.raw`\\[Cheburcheck\\](https://cheburcheck.ru/)`), />Cheburcheck<\/a>/)
for (const citation of ['[^call_random]', String.raw`\[\^call_рандом имя\]`, String.raw`\\[\\^call_xyz\\]`]) {
  assert.equal(inline('before' + citation + 'after'), 'beforeafter')
  assert(!blocks('Text ' + citation).includes('call_'))
  assert(inline('`' + citation + '`').includes('call_'), 'literal code was changed')
  assert(blocks('```md\n' + citation + '\n```').includes('call_'), 'fenced code was changed')
}
assert.equal(inline(String.raw`Text\[\^call_streaming`), 'Text')
assert.equal(inline('[^ordinary_note]'), '[^ordinary_note]')
const example = String.raw`Да, есть. Но важно различать: одни проверяют твоё подключение, другие — наличие сайта в списках блокировок.
Прямо на сайте, без установки

    \[Cheburcheck\](https://cheburcheck.ru/) — вводишь домен или IP и проверяешь его по спискам блокировок РКН и заблокированных CDN-провайдеров. GitHub. Это проверка по спискам, а не тест твоего интернета.\[\^call_gIMaHHFAD9QoddsFxNpAoRMS\]
    \[IPv4 Whitelisted Subnets\](https://hyperion-cs.github.io/dpi-checkers/ru/ipv4-whitelisted-subnets) — ещё один тест от авторов DPI Checkers. Проверяет, какие подсети доступны при интернете «по белым спискам», например на мобильной сети. Перед использованием стоит прочитать инструкцию: сначала нужно подготовить список кнопкой Cache, проверка может идти долго.\[\^call_e255sUFK5uKbm33hhY5xWESL\]
    \[Официальная проверка РКН\](https://blocklist.rkn.gov.ru/) — можно посмотреть, приняты ли меры ограничения доступа к конкретному сайту или странице. Не показывает, что реально работает у твоего провайдера.\[\^call_gIMaHHFAD9QoddsFxNpAoRMS\]

Если готов скачать утилиту

    \[DPI Detector\](https://github.com/Runnin4ik/dpi-detector) — проверяет блокировки сайтов, хостингов и CDN, а также подмену DNS. Есть готовые сборки для Windows.\[\^call_JmngrbE7GGf1zNwUjlaOpQUm\]
    \[RKN Block Checker\](https://github.com/MayersScott/rkn-block-checker) — разбирает, на каком этапе ломается подключение: DNS → TCP → TLS → HTTP. После установки можно запустить локальный веб-интерфейс командой rkn-check startweb.\[\^call_dK91NGDrLfOzRXWovvYSNreP\]`
const exampleHtml = blocks(example)
assert.equal((exampleHtml.match(/<a /g) || []).length, 5)
assert(!exampleHtml.includes('call_') && !exampleHtml.includes('\\'))
for (const label of ['Cheburcheck', 'IPv4 Whitelisted Subnets', 'Официальная проверка РКН', 'DPI Detector', 'RKN Block Checker']) assert(exampleHtml.includes('>' + label + '</a>'))
console.log('Exact reported answer, nested emphasis, multiple escapes, hidden/partial call citations and literal code: PASS')
