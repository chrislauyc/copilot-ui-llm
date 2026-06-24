import React from 'react';

interface MarkdownProps {
  content: string;
}

export default function Markdown({ content }: MarkdownProps) {
  // A simple, safe, non-streaming split that guarantees raw code-blocks
  // preserve all internal contents without leaking into the UI DOM layout.
  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <div className="text-sm font-sans space-y-2 leading-relaxed">
      {parts.map((part, index) => {
        if (part.startsWith('```')) {
          // Extract content between the fences
          const lines = part.split('\n');
          const code = lines.slice(1, -1).join('\n');
          
          return (
            <pre key={index} className="bg-slate-900 text-slate-100 p-3 rounded-md overflow-x-auto font-mono text-xs my-2 block">
              <code>{code}</code>
            </pre>
          );
        }

        // Render plain text segments safely, preserving basic structural newlines
        return (
          <span key={index} className="whitespace-pre-line block">
            {part}
          </span>
        );
      })}
    </div>
  );
}
