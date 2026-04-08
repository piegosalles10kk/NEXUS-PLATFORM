import { ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
  /** Adds a subtle hover lift effect */
  hoverable?: boolean;
  onClick?: () => void;
  padding?: 'sm' | 'md' | 'lg' | 'none';
}

const paddings = { none: '', sm: 'p-4', md: 'p-5', lg: 'p-6' };

export function Card({
  children,
  className = '',
  hoverable = false,
  onClick,
  padding = 'md',
}: CardProps) {
  const base =
    'glass rounded-xl transition-all duration-200';
  const hover = hoverable
    ? 'hover:bg-bg-card-hover hover:border-white/10 hover:-translate-y-0.5 cursor-pointer'
    : '';

  return (
    <div
      className={`${base} ${paddings[padding]} ${hover} ${className}`}
      onClick={onClick}
    >
      {children}
    </div>
  );
}

interface CardHeaderProps {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}

export function CardHeader({ title, description, action, icon }: CardHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4 mb-5">
      <div className="flex items-center gap-3">
        {icon && (
          <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center text-accent-light shrink-0">
            {icon}
          </div>
        )}
        <div>
          <h3 className="text-[15px] font-semibold text-text-primary leading-snug">{title}</h3>
          {description && (
            <p className="text-[13px] text-text-secondary mt-0.5">{description}</p>
          )}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function CardDivider() {
  return <div className="h-px bg-border my-4" />;
}
