// MediaWiki markup to the readable text blocks/wiki/ keeps. Apart from the
// fetch script, editor/test reads this to pin the conversion.
/** Wikitext to readable text: headings kept as markdown, markup and templates dropped. */
export function wikitextToText(wikitext) {
  let text = String(wikitext || '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/\{\{[^{}]*\}\}/g, '');              // templates, one level
  text = text.replace(/\{\{[^{}]*\}\}/g, '');              // and the level they nested in
  text = text.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
  text = text.replace(/<syntaxhighlight[^>]*>([\s\S]*?)<\/syntaxhighlight>/gi, (_, code) => `\n\`\`\`\n${code.trim()}\n\`\`\`\n`);
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => `\n\`\`\`\n${code.trim()}\n\`\`\`\n`);
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/\[\[(?:File|Image|Category):[^\]]*\]\]/gi, '');
  text = text.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2');
  text = text.replace(/\[\[([^\]]*)\]\]/g, '$1');
  text = text.replace(/\[https?:\/\/\S+ ([^\]]*)\]/g, '$1');
  text = text.replace(/'''''|'''|''/g, '');
  // Lists before headings: a wikitext numbered list starts with '#', which is
  // what a markdown heading starts with once converted.
  text = text.replace(/^\*+\s?/gm, '- ').replace(/^#+\s?/gm, '1. ');
  text = text.replace(/^(=+)\s*(.*?)\s*\1\s*$/gm, (_, level, title) => `${'#'.repeat(level.length)} ${title}`);
  text = text.replace(/^\{\|[\s\S]*?\|\}$/gm, match => match.split('\n')
    .filter(line => /^\|[^-}]/.test(line) || /^!/.test(line))
    .map(line => line.replace(/^[|!]\s*/, '').replace(/\s*(\|\||!!)\s*/g, ' | ')).join('\n'));
  // Definition lists -- the wiki's Parameters sections are written as them.
  text = text.replace(/^;\s*(.*)$/gm, '- $1').replace(/^:\s*(.*)$/gm, '  $1');
  text = text.replace(/[ \t]+$/gm, '');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

