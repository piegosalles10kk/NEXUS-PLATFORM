import { ReactNode } from 'react';
import { X, GripVertical } from 'lucide-react';

interface BaseWidgetProps {
  title: string;
  onRemove?: () => void;
  children: ReactNode;
  dragHandleClass?: string;
  onClick?: () => void;
}

export const BaseWidget = ({ title, onRemove, children, dragHandleClass, onClick }: BaseWidgetProps) => {
  return (
    <div 
      onClick={onClick}
      className={`h-full bg-bg-card border border-border rounded-xl flex flex-col overflow-hidden group shadow-sm hover:shadow-md transition-shadow ${onClick ? 'cursor-pointer hover:border-accent/40' : ''}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-bg-secondary/30 border-b border-border">
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <div className={`${dragHandleClass} cursor-grab active:cursor-grabbing p-1 -ml-1 text-text-muted hover:text-text-primary transition-colors`}>
            <GripVertical className="w-3.5 h-3.5" />
          </div>
          <h3 className="text-[10px] font-bold text-text-secondary uppercase tracking-widest truncate max-w-[150px]">
            {title}
          </h3>
        </div>
        {onRemove && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="p-1 rounded-md text-text-muted hover:text-danger hover:bg-danger/10 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 p-4 relative min-h-0">
        {children}
      </div>
    </div>
  );
};
