import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
} from "react";

interface DecryptedTextProps extends HTMLAttributes<HTMLSpanElement> {
  text: string;
  speed?: number;
  maxIterations?: number;
  characters?: string;
  className?: string;
  encryptedClassName?: string;
  parentClassName?: string;
  animateOn?: "view" | "hover" | "click";
}

function DecryptedText({
  text,
  speed = 18,
  maxIterations = 5,
  characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-/.$",
  className = "",
  encryptedClassName = "",
  parentClassName = "",
  animateOn = "view",
  ...props
}: DecryptedTextProps) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasAnimatedRef = useRef(false);
  const [displayText, setDisplayText] = useState(text);
  const [animating, setAnimating] = useState(false);

  const characterSet = useMemo(() => characters.split("").filter(Boolean), [characters]);

  const scramble = useCallback(() => {
    if (prefersReducedMotion()) return text;
    return text
      .split("")
      .map((char) => {
        if (char === " " || char === "\"" || char === ":" || char === "_") return char;
        return characterSet[Math.floor(Math.random() * characterSet.length)] ?? char;
      })
      .join("");
  }, [characterSet, text]);

  const run = useCallback(() => {
    if (prefersReducedMotion() || text.length === 0) {
      setDisplayText(text);
      return;
    }

    clearActiveInterval(intervalRef);
    hasAnimatedRef.current = true;
    setAnimating(true);
    setDisplayText(scramble());

    let iteration = 0;
    intervalRef.current = setInterval(() => {
      iteration += 1;
      if (iteration >= maxIterations) {
        clearActiveInterval(intervalRef);
        setDisplayText(text);
        setAnimating(false);
        return;
      }
      setDisplayText(scramble());
    }, speed);
  }, [maxIterations, scramble, speed, text]);

  useEffect(() => {
    setDisplayText(text);
    setAnimating(false);
    hasAnimatedRef.current = false;
    return () => clearActiveInterval(intervalRef);
  }, [text]);

  useEffect(() => {
    if (animateOn !== "view") return;
    const node = ref.current;
    if (!node) return;

    if (typeof IntersectionObserver === "undefined") {
      run();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !hasAnimatedRef.current) run();
      },
      { threshold: 0.2 },
    );
    observer.observe(node);

    return () => observer.disconnect();
  }, [animateOn, run]);

  const eventProps =
    animateOn === "hover"
      ? { onMouseEnter: run }
      : animateOn === "click"
        ? { onClick: run }
        : {};

  return (
    <span ref={ref} className={parentClassName} {...eventProps} {...props}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true" className={animating ? encryptedClassName : className}>
        {displayText}
      </span>
    </span>
  );
}

function clearActiveInterval(ref: { current: ReturnType<typeof setInterval> | null }) {
  if (!ref.current) return;
  clearInterval(ref.current);
  ref.current = null;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default memo(DecryptedText);
