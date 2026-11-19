import MarkdownIt from 'markdown-it';

// Markdown in a card's text, as HTML the card puts straight into the page -
// so raw HTML in the text is escaped (html: false), and links markdown-it
// won't allow (javascript:, file:, ...) stay text. Links open in a new
// window, which the host turns into the default browser.
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });

const renderLink = markdown.renderer.rules.link_open
  ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noreferrer');
  return renderLink(tokens, index, options, env, self);
};

export const renderMarkdown = (text: string) => markdown.render(text);
