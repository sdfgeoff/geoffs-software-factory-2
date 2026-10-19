import { Marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/dompurify.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));

const markdown = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  renderer: {
    // Treat pasted HTML as visible text, consistent with plain chat messages.
    html(token) { return escapeHtml(token.text); },
    // Files/images are rendered from authenticated attachment records, not remote Markdown URLs.
    image(token) { return escapeHtml(token.text || 'Image'); },
  },
});

let mentionUsers = new Map(), viewerId = null;
export function setMentionUsers(users = [], currentUserId = null) {
  mentionUsers = new Map(users.filter(user => !user.disabled).map(user => [user.username.toLowerCase(), user]));
  viewerId = currentUserId;
}

export function renderMarkdown(value) {
  const html = markdown.parse(String(value ?? ''));
  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'em', 'i', 'del', 's', 'code', 'pre', 'blockquote',
      'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['href', 'title', 'start'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  for (const link of fragment.querySelectorAll('a')) {
    const href = link.getAttribute('href') || '';
    // Restrict active links to web URLs, email addresses, and ordinary local references.
    const allowed = /^(?:https?:\/\/|mailto:|#|\/(?!\/))/i.test(href);
    if (!allowed) { link.removeAttribute('href'); continue; }
    if (/^https?:\/\//i.test(href)) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    }
  }
  // Decorate text nodes only, after sanitization. Code and links keep their literal content.
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) if (!walker.currentNode.parentElement?.closest('code,pre,a')) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue, pattern = /(^|[^a-zA-Z0-9_.@-])@([a-zA-Z0-9][a-zA-Z0-9_.-]*)/g;
    const replacement = document.createDocumentFragment(); let position = 0, decorated = false, match;
    while ((match = pattern.exec(text))) {
      let name=match[2];if(name.length>32){if(!/^\.+$/.test(name.slice(32)))continue;name=name.slice(0,32);}
      while(name.endsWith('.')&&!mentionUsers.has(name.toLowerCase()))name=name.slice(0,-1);
      const user = mentionUsers.get(name.toLowerCase()); if (!user) continue;
      const start = match.index + match[1].length;
      replacement.append(document.createTextNode(text.slice(position, start)));
      const token = document.createElement('span'); token.className = `mention-token${user.id === viewerId ? ' mentions-you' : ''}`;
      token.textContent = `@${name}`; token.title = `${user.display_name}${user.kind === 'agent' ? ' · AI agent' : ''}`;
      replacement.append(token); position = start + name.length + 1; decorated = true;
    }
    if (decorated) { replacement.append(document.createTextNode(text.slice(position))); node.replaceWith(replacement); }
  }
  const wrapper = document.createElement('div');
  wrapper.append(fragment);
  return wrapper.innerHTML;
}
