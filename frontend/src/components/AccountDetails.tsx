import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Animate the measured height, including responsive layouts and loading states. */
export function AccountDetails({ id, expanded, blurred, children }: {
  id: string; expanded: boolean; blurred: boolean; children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => panel.current?.style.setProperty("--account-details-height", `${element.getBoundingClientRect().height}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return <div ref={panel} id={id} className="account-details" aria-hidden={!expanded || blurred} inert={!expanded}>
    <div ref={content} className="account-details-clip">{children}</div>
  </div>;
}
