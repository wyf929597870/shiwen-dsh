import React from 'react';

const safeUrl = value => {
  try {
    const url = new URL(value, 'https://shiwen.invalid');
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? value : null;
  } catch { return null; }
};

function Inline({text}) {
  const source = String(text ?? '');
  const token = /(!?)\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_/g;
  const nodes = [];
  let cursor = 0, match, key = 0;
  while ((match = token.exec(source))) {
    if (match.index > cursor) nodes.push(source.slice(cursor, match.index));
    if (match[2] !== undefined) {
      const href = safeUrl(match[3]);
      if (match[1]) nodes.push(<span className="md-image-label" key={key++}>[图片：{match[2]}]</span>);
      else if (href) nodes.push(<a key={key++} href={href} target="_blank" rel="noreferrer">{match[2]}</a>);
      else nodes.push(match[2]);
    } else if (match[4] !== undefined) nodes.push(<code key={key++}>{match[4]}</code>);
    else if (match[5] !== undefined || match[6] !== undefined) nodes.push(<strong key={key++}>{match[5] ?? match[6]}</strong>);
    else nodes.push(<em key={key++}>{match[7] ?? match[8]}</em>);
    cursor = token.lastIndex;
  }
  if (cursor < source.length) nodes.push(source.slice(cursor));
  return nodes;
}

function isList(line) { return /^\s*(?:[-+*]|\d+[.)])\s+/.test(line); }
function listInfo(line) {
  const m = line.match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
  return m && {indent:m[1].length, ordered:/^\d/.test(m[2]), text:m[3]};
}

/** Safe, dependency-free Markdown reading view. Raw HTML is always rendered as text. */
export function MarkdownView({markdown = ''}) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0, key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^\s*(```+|~~~+)(.*)$/);
    if (fence) {
      const code = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push(<pre key={key++}><code>{code.join('\n')}</code></pre>);
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const Level = `h${heading[1].length}`;
      blocks.push(<Level key={key++}><Inline text={heading[2]}/></Level>); i++; continue;
    }
    if (/^\s{0,3}(?:---+|___+|\*\*\*+)\s*$/.test(line)) { blocks.push(<hr key={key++}/>); i++; continue; }
    if (/^\s*>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push(<blockquote key={key++}><p>{quote.map((part,n)=><React.Fragment key={n}>{n>0&&<br/>}<Inline text={part}/></React.Fragment>)}</p></blockquote>);
      continue;
    }
    if (isList(line)) {
      const first = listInfo(line), items = [];
      while (i < lines.length && isList(lines[i]) && listInfo(lines[i]).ordered === first.ordered) {
        const info = listInfo(lines[i++]);
        items.push(<li key={items.length}><Inline text={info.text}/></li>);
      }
      const List = first.ordered ? 'ol' : 'ul';
      blocks.push(<List key={key++}>{items}</List>); continue;
    }
    const para = [line.trim()]; i++;
    while (i < lines.length && lines[i].trim() && !/^\s{0,3}(?:#{1,6}\s|>|```|~~~)/.test(lines[i]) && !isList(lines[i]) && !/^\s{0,3}(?:---+|___+|\*\*\*+)\s*$/.test(lines[i])) para.push(lines[i++].trim());
    blocks.push(<p key={key++}>{para.map((part,n)=><React.Fragment key={n}>{n>0&&<br/>}<Inline text={part}/></React.Fragment>)}</p>);
  }
  return <div className="markdown-view">{blocks}</div>;
}
