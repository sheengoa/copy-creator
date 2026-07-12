import React from "react";

interface HighlightTextProps {
  text: string;
  search?: string;
}

export const HighlightText: React.FC<HighlightTextProps> = ({ text, search }) => {
  if (!search || !search.trim()) return <>{text}</>;
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === search.toLowerCase()
          ? <mark key={i} className="search-highlight">{part}</mark>
          : <React.Fragment key={i}>{part}</React.Fragment>
      )}
    </>
  );
};
