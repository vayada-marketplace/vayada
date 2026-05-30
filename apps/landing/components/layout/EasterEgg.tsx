"use client";

import { useEffect, useState } from "react";

type Heart = {
  id: number;
  left: number;
  delay: number;
  size: number;
  duration: number;
};

export default function EasterEgg({ visible, onDone }: { visible: boolean; onDone: () => void }) {
  const [hearts, setHearts] = useState<Heart[]>([]);

  useEffect(() => {
    if (!visible) return;

    const newHearts: Heart[] = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      left: Math.random() * 88 + 6,
      delay: Math.random() * 1.2,
      size: Math.random() * 20 + 18,
      duration: Math.random() * 1.5 + 2.5,
    }));
    setHearts(newHearts);

    const timer = setTimeout(() => {
      setHearts([]);
      onDone();
    }, 4500);

    return () => clearTimeout(timer);
  }, [visible, onDone]);

  if (!hearts.length) return null;

  return (
    <div className="fixed inset-0 pointer-events-none z-[9999] overflow-hidden">
      {hearts.map((heart) => (
        <span
          key={heart.id}
          className="absolute bottom-0 animate-float-heart select-none"
          style={{
            left: `${heart.left}%`,
            animationDelay: `${heart.delay}s`,
            animationDuration: `${heart.duration}s`,
            fontSize: `${heart.size}px`,
          }}
        >
          ❤️
        </span>
      ))}
    </div>
  );
}
