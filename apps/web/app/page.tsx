import Link from 'next/link';
import { Logo } from '@/components/Logo';

/**
 * app/page.tsx — landing page.
 *
 * Deliberately restrained: one clear primary action, an honest description of
 * what the system actually does, and the privacy statement. No hero
 * illustrations, no animated gradients.
 */
export default function HomePage() {
  return (
    <div className="mx-auto max-w-[1400px] px-5 py-10">
      {/* Hero */}
      <section className="grid grid-cols-1 gap-10 lg:grid-cols-2 lg:items-center">
        <div>
          <div className="flex items-center gap-3">
            <Logo className="h-10 w-10" />
            <span className="text-label uppercase text-ink-muted">Computer vision · Pose estimation</span>
          </div>

          <h1 className="mt-5 text-display font-semibold tracking-tight text-ink sm:text-[2.75rem]">
            Better form.
            <br />
            A stronger you.
          </h1>

          <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-ink-muted">
            Place your laptop to the side, get into position, and start your set. The coach tracks
            your body in real time, counts every rep, separates clean reps from sloppy ones, and
            tells you exactly what to fix.
          </p>

          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Link href="/workout" className="btn-primary">
              Start workout
            </Link>
            <Link href="/challenge" className="btn-secondary">
              30-second challenge
            </Link>
            <Link href="/leaderboard" className="btn-ghost">
              Leaderboard
            </Link>
          </div>

          <p className="mt-5 text-xs text-ink-faint">
            Video is processed on this device and is not stored.
          </p>
        </div>

        {/* What it actually measures — real, specific, no marketing fluff */}
        <div className="card p-6">
          <h2 className="text-sm font-semibold text-ink">What it measures</h2>
          <p className="mt-1 text-xs text-ink-faint">
            Every value below is derived from joint positions measured in the camera feed.
          </p>

          <dl className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Measure
              term="Elbow angle"
              desc="Tracked per frame to detect the top and bottom of each rep."
            />
            <Measure
              term="Body line"
              desc="Hip deviation from the shoulder-to-ankle line, in torso lengths."
            />
            <Measure
              term="Depth"
              desc="How close the chest came to the floor at the bottom of the rep."
            />
            <Measure
              term="Tempo"
              desc="Rep duration and descent/ascent symmetry."
            />
            <Measure
              term="Alignment"
              desc="How straight you held the shoulder-hip-ankle line."
            />
            <Measure
              term="Consistency"
              desc="Stability of the movement across the rep."
            />
          </dl>

          <div className="mt-6 rounded-card border border-base-border bg-base p-3">
            <p className="text-xs leading-relaxed text-ink-muted">
              Rep counting uses a deterministic geometric state machine. Form quality is judged by a
              classifier trained on 144 labelled push-up videos from 24 people. No language model is
              involved in scoring your form.
            </p>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="mt-14">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-muted">
          How a session works
        </h2>
        <ol className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              n: '01',
              t: 'Camera check',
              d: 'We confirm your full body is visible, the pose is tracking, and you are side-on.',
            },
            {
              n: '02',
              t: 'Calibration',
              d: 'Your own range of motion is measured, so rep detection adapts to you rather than a fixed template.',
            },
            {
              n: '03',
              t: 'Your set',
              d: 'Reps are counted as they complete. Each one is scored and classified as valid or invalid.',
            },
            {
              n: '04',
              t: 'Review',
              d: 'Session results, per-rep breakdown, and progress over time.',
            },
          ].map((s) => (
            <li key={s.n} className="card p-5">
              <span className="font-mono text-xs text-accent">{s.n}</span>
              <h3 className="mt-2 text-sm font-semibold text-ink">{s.t}</h3>
              <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">{s.d}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function Measure({ term, desc }: { term: string; desc: string }) {
  return (
    <div>
      <dt className="text-sm font-medium text-ink">{term}</dt>
      <dd className="mt-0.5 text-xs leading-relaxed text-ink-muted">{desc}</dd>
    </div>
  );
}
