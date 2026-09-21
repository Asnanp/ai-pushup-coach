/**
 * components/Logo.tsx
 *
 * A simple abstract mark suggesting a push-up position: a straight body line
 * with a bent arm supporting it. Deliberately geometric rather than an
 * illustrated mascot — it reads clearly at 32px and looks like it belongs to
 * an engineering tool.
 */

export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      role="img"
      aria-label="AI Push-Up Coach"
    >
      {/* body line: head -> shoulder -> hip -> ankle */}
      <path
        d="M4 21.5 L11 13.5 L21 16.5 L28 20"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-accent"
      />
      {/* supporting arm: shoulder down to hand */}
      <path
        d="M11 13.5 L12.5 23.5"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        className="text-accent"
      />
      {/* head */}
      <circle cx="5.6" cy="22.6" r="2.2" className="fill-accent" />
      {/* hand contact point */}
      <circle cx="12.5" cy="24.6" r="1.6" className="fill-accent" />
    </svg>
  );
}
