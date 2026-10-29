import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MessageContent({ text }: { text: string }) {
  return <div className="markdown">
    <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
      a: ({ children, href }) => <span className="message-link" title={href}>{children}{href && <> ({href})</>}</span>,
      img: ({ alt }) => <span>[Image: {alt || "not loaded"}]</span>,
      table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
    }}>{text}</Markdown>
  </div>;
}
