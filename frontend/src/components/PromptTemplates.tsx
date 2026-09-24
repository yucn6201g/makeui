import { useRef, useState } from 'react';
import { usePresence } from '../hooks/usePresence';
import { useFlip } from '../hooks/useFlip';
import { SlidingIndicator } from './SlidingIndicator';

import { TEMPLATES, CATEGORIES } from '../data/promptTemplates';
export { CHAT_SUGGESTIONS } from '../data/promptTemplates';

interface PromptTemplatesProps {
  onSelect: (prompt: string) => void;
}

export function PromptTemplates({ onSelect }: PromptTemplatesProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeCategory, setActiveCategory] = useState('全て');

  const filteredTemplates = activeCategory === '全て'
    ? TEMPLATES
    : TEMPLATES.filter((t) => t.category === activeCategory);
  const panel = usePresence(isOpen);
  // A category narrows the list by moving what stays, not by redrawing it.
  const listRef = useRef<HTMLUListElement>(null);
  useFlip(listRef, { stagger: 18 });

  return (
    <div className="prompt-templates">
      <button
        className="prompt-templates__header"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-controls="prompt-templates-panel"
        type="button"
      >
        <span className="prompt-templates__header-label">テンプレート</span>
        <span className="prompt-templates__header-icon" aria-hidden="true">
          {isOpen ? '▲' : '▼'}
        </span>
      </button>
      {panel.mounted && (
        <div className="prompt-templates__panel" id="prompt-templates-panel" role="region" aria-label="プロンプトテンプレート" data-state={panel.state}>
          <div className="prompt-templates__categories motion-track" role="group" aria-label="カテゴリフィルター">
            <SlidingIndicator active={activeCategory} />
            {CATEGORIES.map((category) => (
              <button
                key={category}
                className={`prompt-templates__chip${activeCategory === category ? ' prompt-templates__chip--active' : ''}`}
                onClick={() => setActiveCategory(category)}
                aria-pressed={activeCategory === category}
                type="button"
              >
                {category}
              </button>
            ))}
          </div>
          <ul className="prompt-templates__list" ref={listRef}>
            {filteredTemplates.map((template) => (
              <li key={template.id}>
                <button
                  className="prompt-templates__card"
                  onClick={() => onSelect(template.prompt)}
                  type="button"
                  aria-label={`テンプレートを選択: ${template.label}`}
                >
                  <span className="prompt-templates__card-label">{template.label}</span>
                  <span className="prompt-templates__card-preview">{template.summary}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
