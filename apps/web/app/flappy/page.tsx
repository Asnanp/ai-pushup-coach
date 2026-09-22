'use client';

/**
 * apps/web/app/flappy/page.tsx
 *
 * Flappy Push-Up (Push-Up Bird)
 *
 * An interactive, gamified workout mode where the player controls an animated
 * athletic bird's altitude directly through real-time camera tracking of their
 * push-up position (nose & head vertical displacement).
 *
 * Control Mechanics:
 *   - Lockout / Plank (High) -> Bird flies to upper sky
 *   - Chest to Deck / Push-up Depth (Low) -> Bird dives towards ground
 *   - Obstacle Navigation: High pipes require lockout; low pipes require deep push-ups!
 *   - Push-Up Rep Bonus: Completing a full down-up repetition counts a workout rep,
 *     awards +5 bonus score, and triggers particle celebration!
 *
 * Features:
 *   - 3 Difficulty Levels: Easy, Medium, Hard
 *   - 100% on-device Web Audio API chiptune sound effects (zero network dependencies)
 *   - PiP Camera Viewfinder with real-time nose reticle and depth meter
 *   - High score persistence in localStorage
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { CameraEngine } from '@/lib/camera';
import { PoseEngine } from '@ai-pushup-coach/pose';
import type { PoseFrame } from '@ai-pushup-coach/types';

// ============================================================================
// Types & Difficulty Configurations
// ============================================================================

export type Difficulty = 'easy' | 'medium' | 'hard';

interface DifficultyConfig {
  id: Difficulty;
  label: string;
  speed: number;
  gapHeight: number;
  spawnInterval: number; // frames between pipes
  color: string;
  description: string;
}

const DIFFICULTY_CONFIGS: Record<Difficulty, DifficultyConfig> = {
  easy: {
    id: 'easy',
    label: 'Easy',
    speed: 2.0,
    gapHeight: 215,
    spawnInterval: 210,
    color: '#10B981', // emerald
    description: 'Generous gaps, gentle scrolling speed. Ideal for warmups.',
  },
  medium: {
    id: 'medium',
    label: 'Medium',
    speed: 2.8,
    gapHeight: 165,
    spawnInterval: 160,
    color: '#0284C7', // sky
    description: 'Standard athletic pacing. Requires controlled push-up depth.',
  },
  hard: {
    id: 'hard',
    label: 'Hard',
    speed: 3.6,
    gapHeight: 130,
    spawnInterval: 120,
    color: '#E11D48', // rose/crimson
    description: 'Tight gaps and rapid pace. Demands explosive power and fast recovery.',
  },
};

// ============================================================================
// Built-In Web Audio API Sound Synthesizer (Zero External Dependencies)
// ============================================================================

class SoundFx {
  private ctx: AudioContext | null = null;
  public enabled = true;

  private init() {
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  playPass() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(987.77, now); // B5
    osc.frequency.setValueAtTime(1318.51, now + 0.07); // E6
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    osc.start(now);
    osc.stop(now + 0.25);
  }

  playRepBonus() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Triumphant powerup arpeggio: C5 -> E5 -> G5 -> C6
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, i) => {
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.type = 'triangle';
      const t = now + i * 0.055;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.18, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      osc.start(t);
      osc.stop(t + 0.22);
    });
  }

  playCrash() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(35, now + 0.35);
    gain.gain.setValueAtTime(0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc.start(now);
    osc.stop(now + 0.35);
  }
}

const sfx = new SoundFx();

// ============================================================================
// Game State Types
// ============================================================================

type GameState = 'STANDBY' | 'CALIBRATING' | 'COUNTDOWN' | 'PLAYING' | 'GAMEOVER';

interface Pipe {
  x: number;
  width: number;
  topHeight: number;
  bottomY: number;
  passed: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  alpha: number;
  color: string;
}

interface FloatingText {
  text: string;
  x: number;
  y: number;
  alpha: number;
  color: string;
}

// ============================================================================
// Main Page Component
// ============================================================================

export default function FlappyPushUpPage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pipCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const cameraRef = useRef<CameraEngine | null>(null);
  const poseRef = useRef<PoseEngine | null>(null);

  const [gameState, setGameState] = useState<GameState>('STANDBY');
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [score, setScore] = useState(0);
  const [highScore, setHighScore] = useState(0);
  const [repsCount, setRepsCount] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [countdownNum, setCountdownNum] = useState(3);
  const [liveNoseAltitude, setLiveNoseAltitude] = useState(0.5); // [0, 1] 1 = top plank, 0 = bottom
  const [calibratedRange, setCalibratedRange] = useState({ topY: 0.32, bottomY: 0.65 });

  // References for the 60fps game loop
  const gameStateRef = useRef<GameState>('STANDBY');
  const difficultyRef = useRef<Difficulty>('medium');
  const scoreRef = useRef(0);
  const repsCountRef = useRef(0);
  const animationFrameId = useRef<number | null>(null);

  // Altitude tracking references
  const targetAltitudeRef = useRef(0.5);
  const currentAltitudeRef = useRef(0.5);
  const rangeRef = useRef({ topY: 0.32, bottomY: 0.65 });
  const repStateRef = useRef<'TOP' | 'BOTTOM' | 'MOVING'>('TOP');

  // Game entities
  const birdRef = useRef({
    x: 120,
    y: 250,
    vy: 0,
    radius: 17,
    tilt: 0,
    wingAngle: 0,
  });
  const pipesRef = useRef<Pipe[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const floatingTextsRef = useRef<FloatingText[]>([]);
  const frameCountRef = useRef(0);

  // Sync state to refs
  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  useEffect(() => {
    difficultyRef.current = difficulty;
  }, [difficulty]);

  useEffect(() => {
    scoreRef.current = score;
  }, [score]);

  useEffect(() => {
    repsCountRef.current = repsCount;
  }, [repsCount]);

  // Load high score from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`flappy_pushup_highscore_${difficulty}`);
      if (saved) setHighScore(parseInt(saved, 10) || 0);
      else setHighScore(0);
    } catch {
      // ignore
    }
  }, [difficulty]);

  // Mute toggle
  const toggleMute = () => {
    const next = !isMuted;
    setIsMuted(next);
    sfx.enabled = !next;
  };

  // --------------------------------------------------------------------------
  // Camera & Pose Pipeline
  // --------------------------------------------------------------------------
  const startCameraAndPose = useCallback(async () => {
    if (cameraActive) return true;
    try {
      const video = videoRef.current;
      if (!video) return false;

      const camera = new CameraEngine();
      cameraRef.current = camera;
      await camera.start(video, { width: 640, height: 480, fps: 30 });

      const pose = new PoseEngine({
        targetFps: 30,
        onFrame: (frame: PoseFrame) => {
          handlePoseFrame(frame);
        },
      });
      poseRef.current = pose;
      const ok = await pose.init();
      if (!ok) return false;

      pose.start(video);
      setCameraActive(true);
      return true;
    } catch (err) {
      console.error('Camera initialization failed:', err);
      return false;
    }
  }, [cameraActive]);

  const stopCameraAndPose = useCallback(async () => {
    poseRef.current?.stop();
    poseRef.current = null;
    await cameraRef.current?.stop();
    cameraRef.current = null;
    setCameraActive(false);
  }, []);

  // Process incoming landmarks for altitude and rep detection
  const handlePoseFrame = useCallback((frame: PoseFrame) => {
    if (!frame.valid || !frame.landmarks || frame.landmarks.length < 1) return;

    // Landmark 0 is NOSE
    const nose = frame.landmarks[0];
    if (!nose || !Number.isFinite(nose.y)) return;

    // Optional shoulder blending for stability
    let observedY = nose.y;
    if (frame.landmarks.length >= 13) {
      const shL = frame.landmarks[11];
      const shR = frame.landmarks[12];
      if (shL && shR && Number.isFinite(shL.y) && Number.isFinite(shR.y)) {
        observedY = (nose.y * 2 + (shL.y + shR.y) / 2) / 3;
      }
    }

    // Adaptive range calibration:
    // In camera coordinates, 0 is top of frame, 1 is bottom.
    // In push-up:
    //   - Lockout/Plank is higher in physical space -> lower value in camera coords (e.g. 0.25 - 0.35)
    //   - Chest-to-deck is lower in physical space -> higher value in camera coords (e.g. 0.60 - 0.75)
    const currentRange = rangeRef.current;
    if (observedY < currentRange.topY) {
      currentRange.topY = Math.max(0.1, observedY - 0.02);
    }
    if (observedY > currentRange.bottomY) {
      currentRange.bottomY = Math.min(0.9, observedY + 0.02);
    }
    setCalibratedRange({ ...currentRange });

    const span = Math.max(0.15, currentRange.bottomY - currentRange.topY);
    // Normalized push-up altitude [0 = Bottom of push-up, 1 = Full plank lockout]
    const altitude = Math.max(0, Math.min(1, (currentRange.bottomY - observedY) / span));

    targetAltitudeRef.current = altitude;
    setLiveNoseAltitude(altitude);

    // Draw PiP Reticle on PiP canvas
    const pipCanvas = pipCanvasRef.current;
    if (pipCanvas) {
      const ctx = pipCanvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, pipCanvas.width, pipCanvas.height);
        const px = nose.x * pipCanvas.width;
        const py = nose.y * pipCanvas.height;

        // Glowing targeting crosshair on nose
        ctx.strokeStyle = '#10B981';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, 10, 0, Math.PI * 2);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(px - 14, py);
        ctx.lineTo(px + 14, py);
        ctx.moveTo(px, py - 14);
        ctx.lineTo(px, py + 14);
        ctx.stroke();

        // Center dot
        ctx.fillStyle = '#34D399';
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Push-Up Rep Cycle Detection
    // Top is > 0.78; Bottom depth is < 0.28
    const repState = repStateRef.current;
    if (repState === 'TOP' && altitude < 0.28) {
      repStateRef.current = 'BOTTOM';
      // Trigger bottom depth sound / splash
      createParticles(birdRef.current.x, birdRef.current.y, 8, '#34D399');
      addFloatingText('DEPTH HIT ✓', birdRef.current.x, birdRef.current.y - 20, '#10B981');
    } else if (repState === 'BOTTOM' && altitude > 0.78) {
      repStateRef.current = 'TOP';
      // Completed a full rep!
      const newReps = repsCountRef.current + 1;
      setRepsCount(newReps);
      repsCountRef.current = newReps;

      // Bonus score!
      const bonus = 5;
      const newScore = scoreRef.current + bonus;
      setScore(newScore);
      scoreRef.current = newScore;

      sfx.playRepBonus();
      createParticles(birdRef.current.x, birdRef.current.y, 16, '#F59E0B');
      addFloatingText(`+${bonus} REP BONUS! 🔥`, birdRef.current.x, birdRef.current.y - 30, '#F59E0B');
    }
  }, []);

  const createParticles = (x: number, y: number, count: number, color: string) => {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1.5 + Math.random() * 3.5;
      particlesRef.current.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        radius: 2 + Math.random() * 3,
        alpha: 1.0,
        color,
      });
    }
  };

  const addFloatingText = (text: string, x: number, y: number, color: string) => {
    floatingTextsRef.current.push({ text, x, y, alpha: 1.0, color });
  };

  // --------------------------------------------------------------------------
  // Game Lifecycle Control
  // --------------------------------------------------------------------------
  const startGameFlow = async () => {
    const ready = await startCameraAndPose();
    if (!ready) {
      alert('Camera access is required to play Flappy Push-Up. Please enable your camera.');
      return;
    }

    setScore(0);
    setRepsCount(0);
    scoreRef.current = 0;
    repsCountRef.current = 0;
    pipesRef.current = [];
    particlesRef.current = [];
    floatingTextsRef.current = [];
    frameCountRef.current = 0;
    repStateRef.current = 'TOP';

    // Center bird
    birdRef.current.y = 260;
    birdRef.current.vy = 0;
    birdRef.current.tilt = 0;

    // 3-2-1 Countdown
    setGameState('COUNTDOWN');
    setCountdownNum(3);

    let count = 3;
    const timer = setInterval(() => {
      count -= 1;
      if (count > 0) {
        setCountdownNum(count);
      } else {
        clearInterval(timer);
        setGameState('PLAYING');
      }
    }, 900);
  };

  const handleGameOver = useCallback(() => {
    setGameState('GAMEOVER');
    sfx.playCrash();

    const currentFinal = scoreRef.current;
    const currentHigh = highScore;
    if (currentFinal > currentHigh) {
      setHighScore(currentFinal);
      try {
        localStorage.setItem(`flappy_pushup_highscore_${difficultyRef.current}`, currentFinal.toString());
      } catch {
        // ignore
      }
    }
  }, [highScore]);

  // Clean up camera when leaving page
  useEffect(() => {
    return () => {
      stopCameraAndPose();
      if (animationFrameId.current) {
        cancelAnimationFrame(animationFrameId.current);
      }
    };
  }, [stopCameraAndPose]);

  // --------------------------------------------------------------------------
  // Main 60 FPS Canvas Game Loop
  // --------------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = 800;
    const height = 500;
    canvas.width = width;
    canvas.height = height;

    const groundHeight = 50;
    const playableHeight = height - groundHeight;

    const loop = () => {
      frameCountRef.current++;
      const currentDifficulty = DIFFICULTY_CONFIGS[difficultyRef.current];

      // ----------------------------------------------------------------------
      // 1. Update Physics
      // ----------------------------------------------------------------------
      if (gameStateRef.current === 'PLAYING') {
        // Altitude interpolation:
        // altitude 1.0 = top plank (bird near top, y ~ 65px)
        // altitude 0.0 = bottom pushup (bird near floor, y ~ 410px)
        const targetAlt = targetAltitudeRef.current;
        currentAltitudeRef.current += (targetAlt - currentAltitudeRef.current) * 0.18;

        const targetY = 60 + (1 - currentAltitudeRef.current) * (playableHeight - 110);
        const bird = birdRef.current;

        const prevY = bird.y;
        bird.y += (targetY - bird.y) * 0.22;
        bird.vy = bird.y - prevY;

        // Smooth tilt based on ascent/descent
        const targetTilt = Math.max(-0.45, Math.min(0.55, bird.vy * 0.045));
        bird.tilt += (targetTilt - bird.tilt) * 0.2;

        // Wing flap speed proportional to vertical movement
        bird.wingAngle += 0.2 + Math.abs(bird.vy) * 0.08;

        // Drop subtle trail feathers
        if (Math.abs(bird.vy) > 1.8 && frameCountRef.current % 4 === 0) {
          createParticles(bird.x - 14, bird.y + (Math.random() * 6 - 3), 1, '#FDE047');
        }

        // Spawn Pipes
        if (frameCountRef.current % currentDifficulty.spawnInterval === 0) {
          const gap = currentDifficulty.gapHeight;
          const minTop = 50;
          const maxTop = playableHeight - gap - 50;
          const topH = minTop + Math.random() * (maxTop - minTop);

          pipesRef.current.push({
            x: width + 20,
            width: 65,
            topHeight: topH,
            bottomY: topH + gap,
            passed: false,
          });
        }

        // Update Pipes & Check Collisions
        for (let i = pipesRef.current.length - 1; i >= 0; i--) {
          const p = pipesRef.current[i];
          p.x -= currentDifficulty.speed;

          // Check pass
          if (!p.passed && p.x + p.width < bird.x) {
            p.passed = true;
            const nextScore = scoreRef.current + 1;
            setScore(nextScore);
            scoreRef.current = nextScore;
            sfx.playPass();
            addFloatingText('+1', bird.x, bird.y - 24, '#38BDF8');
          }

          // Collision Detection (Circle vs Rect)
          const birdBoxLeft = bird.x - bird.radius + 3;
          const birdBoxRight = bird.x + bird.radius - 3;
          const birdBoxTop = bird.y - bird.radius + 3;
          const birdBoxBottom = bird.y + bird.radius - 3;

          const inHorizontalRange = birdBoxRight > p.x && birdBoxLeft < p.x + p.width;
          const hitTopPipe = inHorizontalRange && birdBoxTop < p.topHeight;
          const hitBottomPipe = inHorizontalRange && birdBoxBottom > p.bottomY;

          if (hitTopPipe || hitBottomPipe) {
            createParticles(bird.x, bird.y, 25, '#EF4444');
            handleGameOver();
            break;
          }

          // Remove off-screen pipes
          if (p.x + p.width < -50) {
            pipesRef.current.splice(i, 1);
          }
        }

        // Ground & Ceiling Collisions
        if (bird.y - bird.radius < 10) {
          bird.y = 10 + bird.radius;
        }
        if (bird.y + bird.radius > playableHeight) {
          createParticles(bird.x, bird.y, 25, '#EF4444');
          handleGameOver();
        }
      }

      // Update Particles
      for (let i = particlesRef.current.length - 1; i >= 0; i--) {
        const pt = particlesRef.current[i];
        pt.x += pt.vx;
        pt.y += pt.vy;
        pt.alpha -= 0.025;
        if (pt.alpha <= 0) particlesRef.current.splice(i, 1);
      }

      // Update Floating Texts
      for (let i = floatingTextsRef.current.length - 1; i >= 0; i--) {
        const ft = floatingTextsRef.current[i];
        ft.y -= 0.8;
        ft.alpha -= 0.02;
        if (ft.alpha <= 0) floatingTextsRef.current.splice(i, 1);
      }

      // ----------------------------------------------------------------------
      // 2. Render Scene
      // ----------------------------------------------------------------------
      ctx.clearRect(0, 0, width, height);

      // Sky gradient (athletic dark obsidian to deep slate)
      const skyGrad = ctx.createLinearGradient(0, 0, 0, height);
      skyGrad.addColorStop(0, '#0F172A'); // slate-900
      skyGrad.addColorStop(0.7, '#1E293B'); // slate-800
      skyGrad.addColorStop(1, '#0B0F19');
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, width, height);

      // Distant athletic arena grid lines
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
      ctx.lineWidth = 1;
      const gridOffset = (frameCountRef.current * 0.5) % 40;
      for (let x = -gridOffset; x < width; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, playableHeight);
        ctx.stroke();
      }
      for (let y = 0; y < playableHeight; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      // Render Obstacle Pipes
      pipesRef.current.forEach((p) => {
        const capHeight = 22;
        const capOverlap = 4;
        const col = currentDifficulty.color;

        // Top Pipe Body
        ctx.fillStyle = '#1E293B';
        ctx.fillRect(p.x, 0, p.width, p.topHeight);

        // Top Pipe Inner Shadow / Highlights
        ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
        ctx.fillRect(p.x + 6, 0, 8, p.topHeight);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
        ctx.fillRect(p.x + p.width - 10, 0, 10, p.topHeight);

        // Top Pipe Cap
        ctx.fillStyle = '#0F172A';
        ctx.fillRect(p.x - capOverlap, p.topHeight - capHeight, p.width + capOverlap * 2, capHeight);
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.strokeRect(p.x - capOverlap, p.topHeight - capHeight, p.width + capOverlap * 2, capHeight);

        // Bottom Pipe Body
        ctx.fillStyle = '#1E293B';
        ctx.fillRect(p.x, p.bottomY, p.width, playableHeight - p.bottomY);

        // Bottom Pipe Inner Highlights
        ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
        ctx.fillRect(p.x + 6, p.bottomY, 8, playableHeight - p.bottomY);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
        ctx.fillRect(p.x + p.width - 10, p.bottomY, 10, playableHeight - p.bottomY);

        // Bottom Pipe Cap
        ctx.fillStyle = '#0F172A';
        ctx.fillRect(p.x - capOverlap, p.bottomY, p.width + capOverlap * 2, capHeight);
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.strokeRect(p.x - capOverlap, p.bottomY, p.width + capOverlap * 2, capHeight);
      });

      // Ground (Athletic Track)
      const groundGrad = ctx.createLinearGradient(0, playableHeight, 0, height);
      groundGrad.addColorStop(0, '#1E293B');
      groundGrad.addColorStop(1, '#0F172A');
      ctx.fillStyle = groundGrad;
      ctx.fillRect(0, playableHeight, width, groundHeight);

      // Neon Track Boundary Line
      ctx.strokeStyle = '#10B981';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(0, playableHeight);
      ctx.lineTo(width, playableHeight);
      ctx.stroke();

      // Track hashes
      const trackSpeed = gameStateRef.current === 'PLAYING' ? currentDifficulty.speed : 1.2;
      const hashOffset = (frameCountRef.current * trackSpeed) % 24;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 2;
      for (let x = -hashOffset; x < width; x += 24) {
        ctx.beginPath();
        ctx.moveTo(x, playableHeight + 8);
        ctx.lineTo(x + 10, height);
        ctx.stroke();
      }

      // Render Particles
      particlesRef.current.forEach((pt) => {
        ctx.save();
        ctx.globalAlpha = Math.max(0, pt.alpha);
        ctx.fillStyle = pt.color;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });

      // Render Bird (Athlete Flappy Character)
      const bird = birdRef.current;
      ctx.save();
      ctx.translate(bird.x, bird.y);
      ctx.rotate(bird.tilt);

      // 1. Bird Body (Vibrant Golden Plumage)
      ctx.fillStyle = '#FBBF24';
      ctx.beginPath();
      ctx.arc(0, 0, bird.radius, 0, Math.PI * 2);
      ctx.fill();

      // 2. Belly (Lighter Cream Plumage)
      ctx.fillStyle = '#FEF08A';
      ctx.beginPath();
      ctx.arc(-2, 4, bird.radius * 0.65, 0, Math.PI * 2);
      ctx.fill();

      // 3. Wing (Animated Flapping)
      ctx.save();
      const wingFlap = Math.sin(bird.wingAngle) * 6;
      ctx.fillStyle = '#F59E0B';
      ctx.beginPath();
      ctx.ellipse(-6, 2 + wingFlap * 0.4, 10, 6, -0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // 4. Workout Headband (Athletic Sweatband)
      ctx.fillStyle = '#EF4444'; // Red athletic headband
      ctx.fillRect(-bird.radius + 1, -bird.radius + 2, bird.radius * 2 - 2, 6);
      // Headband white stripe
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(-bird.radius + 1, -bird.radius + 4, bird.radius * 2 - 2, 2);

      // 5. Eye (Large expressive athletic eye)
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(7, -3, 6, 0, Math.PI * 2);
      ctx.fill();
      // Pupil
      ctx.fillStyle = '#0F172A';
      ctx.beginPath();
      ctx.arc(9, -3, 2.5, 0, Math.PI * 2);
      ctx.fill();

      // 6. Beak
      ctx.fillStyle = '#F97316';
      ctx.beginPath();
      ctx.moveTo(13, -1);
      ctx.lineTo(24, 2);
      ctx.lineTo(13, 6);
      ctx.closePath();
      ctx.fill();

      ctx.restore();

      // Render Floating Text Labels
      floatingTextsRef.current.forEach((ft) => {
        ctx.save();
        ctx.globalAlpha = Math.max(0, ft.alpha);
        ctx.fillStyle = ft.color;
        ctx.font = 'bold 16px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(ft.text, ft.x, ft.y);
        ctx.restore();
      });

      animationFrameId.current = requestAnimationFrame(loop);
    };

    animationFrameId.current = requestAnimationFrame(loop);
    return () => {
      if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
    };
  }, [handleGameOver]);

  // --------------------------------------------------------------------------
  // Render JSX
  // --------------------------------------------------------------------------
  return (
    <main className="min-h-screen bg-base pb-24 text-ink">
      {/* Top Header Bar */}
      <div className="border-b border-base-border bg-base-raised/70 backdrop-blur-md sticky top-0 z-40">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="text-xs font-semibold uppercase tracking-wider text-ink-muted hover:text-ink transition-colors"
            >
              ← Back to App
            </Link>
            <span className="text-base-border">|</span>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold tracking-tight">Flappy Push-Up</span>
              <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-600 border border-emerald-500/20">
                Nose Vision Flight
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={toggleMute}
              className="rounded-full border border-base-border p-2 text-ink-muted hover:text-ink hover:border-ink transition-colors text-xs"
              title={isMuted ? 'Unmute Sound FX' : 'Mute Sound FX'}
              aria-label="Toggle Sound"
            >
              {isMuted ? '🔇 Muted' : '🔊 Sound On'}
            </button>
            <Link
              href="/workout"
              className="rounded-full border border-ink/80 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-ink hover:bg-ink hover:text-base transition-all"
            >
              Regular Workout ↗
            </Link>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-5xl px-6 pt-6">
        {/* Game Area Container */}
        <div className="relative overflow-hidden rounded-2xl border border-base-border bg-black shadow-2xl">
          {/* Main 60fps Game Canvas */}
          <canvas
            ref={canvasRef}
            className="w-full h-auto block select-none cursor-default"
            style={{ aspectRatio: '16 / 10' }}
          />

          {/* Picture-in-Picture Live Camera Viewfinder */}
          <div className="absolute top-4 right-4 z-30 flex flex-col items-end gap-2">
            <div className="relative w-44 h-32 rounded-xl overflow-hidden border-2 border-white/20 bg-slate-900 shadow-xl">
              <video
                ref={videoRef}
                className="w-full h-full object-cover mirror-x"
                playsInline
                muted
                style={{ transform: 'scaleX(-1)' }}
              />
              <canvas
                ref={pipCanvasRef}
                width={176}
                height={128}
                className="absolute inset-0 w-full h-full pointer-events-none"
                style={{ transform: 'scaleX(-1)' }}
              />

              {/* Live Status Badge */}
              <div className="absolute top-1.5 left-1.5 z-10 flex items-center gap-1.5 rounded-md bg-black/70 px-2 py-0.5 backdrop-blur-md">
                <span
                  className={clsx(
                    'h-2 w-2 rounded-full',
                    cameraActive ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400',
                  )}
                />
                <span className="text-[10px] font-semibold text-white tracking-wider">
                  {cameraActive ? 'NOSE TRACKED' : 'CAMERA OFF'}
                </span>
              </div>

              {/* Vertical Altitude Thermometer Gauge */}
              <div className="absolute right-1.5 top-1.5 bottom-1.5 w-2 rounded-full bg-white/10 overflow-hidden">
                <div
                  className="w-full bg-emerald-400 rounded-full transition-all duration-75"
                  style={{
                    height: `${Math.round(liveNoseAltitude * 100)}%`,
                    marginTop: `${100 - Math.round(liveNoseAltitude * 100)}%`,
                  }}
                />
              </div>
            </div>

            {/* Depth Telemetry Chip */}
            <div className="flex items-center gap-2 rounded-lg bg-black/80 px-2.5 py-1 text-[11px] font-mono text-white/90 border border-white/10 backdrop-blur-md">
              <span className="text-white/60">ALTITUDE:</span>
              <span className="font-bold text-emerald-400">{(liveNoseAltitude * 100).toFixed(0)}%</span>
              <span className="text-white/40">|</span>
              <span className="text-white/60">REPS:</span>
              <span className="font-bold text-amber-400">{repsCount}</span>
            </div>
          </div>

          {/* Active In-Game HUD (Floating Top-Left) */}
          {gameState === 'PLAYING' && (
            <div className="absolute top-5 left-5 z-20 flex items-center gap-4">
              <div className="rounded-xl bg-black/70 px-4 py-2 border border-white/10 backdrop-blur-md flex items-center gap-3">
                <span className="text-xs uppercase tracking-widest text-white/60 font-semibold">SCORE</span>
                <span className="text-3xl font-extrabold text-white tabular font-mono">{score}</span>
              </div>

              <div className="rounded-xl bg-black/70 px-3.5 py-2 border border-white/10 backdrop-blur-md flex items-center gap-2">
                <span className="text-lg">🔥</span>
                <span className="text-xs uppercase tracking-widest text-white/60 font-semibold">REPS</span>
                <span className="text-xl font-bold text-amber-400 tabular font-mono">{repsCount}</span>
              </div>

              <div className="rounded-xl bg-black/70 px-3.5 py-2 border border-white/10 backdrop-blur-md flex items-center gap-2">
                <span className="text-xs uppercase tracking-widest text-white/60 font-semibold">BEST</span>
                <span className="text-lg font-bold text-white/90 tabular font-mono">{highScore}</span>
              </div>
            </div>
          )}

          {/* 3-2-1 Countdown Overlay */}
          {gameState === 'COUNTDOWN' && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/75 backdrop-blur-sm">
              <span className="text-8xl font-black text-emerald-400 animate-bounce font-mono">
                {countdownNum}
              </span>
              <p className="mt-4 text-sm font-semibold uppercase tracking-widest text-white/80">
                Get into plank position!
              </p>
              <p className="mt-1 text-xs text-white/50">
                Push up to fly high · Dive down to skim low
              </p>
            </div>
          )}

          {/* Standby / Start Screen Overlay */}
          {gameState === 'STANDBY' && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/85 backdrop-blur-md px-6 text-center">
              <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-1 text-xs font-semibold text-emerald-400 mb-4">
                <span>🐦🏋️‍♂️ Interactive Fitness Mini-Game</span>
              </div>

              <h1 className="text-4xl md:text-5xl font-black tracking-tight text-white mb-3">
                FLAPPY PUSH-UP<span className="text-emerald-500">.</span>
              </h1>
              <p className="max-w-md text-sm text-white/70 leading-relaxed mb-6">
                Your real nose & chest position controls the bird. Push up to lockout to soar high; dive deep to deck to navigate low tunnels!
              </p>

              {/* Difficulty Selection */}
              <div className="mb-6 flex flex-col items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-white/50">Select Difficulty</span>
                <div className="flex items-center gap-2 bg-white/5 p-1 rounded-full border border-white/10">
                  {(['easy', 'medium', 'hard'] as Difficulty[]).map((d) => {
                    const cfg = DIFFICULTY_CONFIGS[d];
                    const active = difficulty === d;
                    return (
                      <button
                        key={d}
                        onClick={() => setDifficulty(d)}
                        className={clsx(
                          'rounded-full px-4 py-1.5 text-xs font-semibold uppercase tracking-wider transition-all cursor-pointer',
                          active
                            ? 'bg-white text-black shadow-md'
                            : 'text-white/70 hover:text-white hover:bg-white/10',
                        )}
                      >
                        {cfg.label}
                      </button>
                    );
                  })}
                </div>
                <span className="text-xs text-white/40 mt-1 max-w-sm">
                  {DIFFICULTY_CONFIGS[difficulty].description}
                </span>
              </div>

              {/* Start Button */}
              <button
                onClick={startGameFlow}
                className="rounded-full bg-emerald-500 hover:bg-emerald-400 px-8 py-3.5 text-sm font-bold uppercase tracking-wider text-black transition-all transform hover:scale-105 shadow-lg shadow-emerald-500/25 cursor-pointer"
              >
                Start Game 🚀
              </button>

              {highScore > 0 && (
                <div className="mt-6 text-xs text-white/50 font-mono">
                  Personal Best ({DIFFICULTY_CONFIGS[difficulty].label}):{' '}
                  <span className="font-bold text-white">{highScore} pts</span>
                </div>
              )}
            </div>
          )}

          {/* Game Over Screen Overlay */}
          {gameState === 'GAMEOVER' && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/85 backdrop-blur-md px-6 text-center animate-fadeIn">
              <span className="text-xs font-semibold uppercase tracking-widest text-rose-400 mb-2">
                RUN FINISHED
              </span>
              <h2 className="text-4xl md:text-5xl font-black text-white tracking-tight mb-4">
                GAME OVER<span className="text-rose-500">.</span>
              </h2>

              <div className="grid grid-cols-2 gap-4 max-w-xs w-full mb-6">
                <div className="rounded-xl bg-white/5 border border-white/10 p-3.5">
                  <span className="block text-[11px] uppercase tracking-wider text-white/50 font-semibold">SCORE</span>
                  <span className="text-3xl font-extrabold text-white font-mono">{score}</span>
                </div>
                <div className="rounded-xl bg-white/5 border border-white/10 p-3.5">
                  <span className="block text-[11px] uppercase tracking-wider text-white/50 font-semibold">PUSH-UPS</span>
                  <span className="text-3xl font-extrabold text-amber-400 font-mono">{repsCount}</span>
                </div>
              </div>

              {score >= highScore && score > 0 && (
                <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 border border-amber-500/30 px-3.5 py-1 text-xs font-bold text-amber-400 mb-6 animate-pulse">
                  🏆 NEW HIGH SCORE!
                </div>
              )}

              <div className="flex items-center gap-3">
                <button
                  onClick={startGameFlow}
                  className="rounded-full bg-emerald-500 hover:bg-emerald-400 px-7 py-3 text-xs font-bold uppercase tracking-wider text-black transition-all transform hover:scale-105 shadow-md shadow-emerald-500/25 cursor-pointer"
                >
                  Play Again ↺
                </button>
                <button
                  onClick={() => setGameState('STANDBY')}
                  className="rounded-full border border-white/20 hover:border-white px-5 py-3 text-xs font-semibold uppercase tracking-wider text-white transition-colors cursor-pointer"
                >
                  Change Level
                </button>
              </div>
            </div>
          )}
        </div>

        {/* How to Play Guide & Biomechanics Overview */}
        <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="rounded-2xl border border-base-border bg-base-raised p-6">
            <div className="flex items-center gap-2 mb-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 text-xs font-bold">1</span>
              <h3 className="text-sm font-bold text-ink">Physical Altitude Control</h3>
            </div>
            <p className="text-xs text-ink-muted leading-relaxed">
              In plank lockout, your nose is high and the bird flies up. When descending chest-to-floor, your nose drops and the bird dives towards the deck.
            </p>
          </div>

          <div className="rounded-2xl border border-base-border bg-base-raised p-6">
            <div className="flex items-center gap-2 mb-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-sky-500/10 text-sky-600 text-xs font-bold">2</span>
              <h3 className="text-sm font-bold text-ink">Rep Bonus Combos</h3>
            </div>
            <p className="text-xs text-ink-muted leading-relaxed">
              Every full push-up rep from lockout down to full depth and back earns you +5 bonus points, rep audio fanfare, and logs your workout total.
            </p>
          </div>

          <div className="rounded-2xl border border-base-border bg-base-raised p-6">
            <div className="flex items-center gap-2 mb-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-rose-500/10 text-rose-600 text-xs font-bold">3</span>
              <h3 className="text-sm font-bold text-ink">3 Calibrated Levels</h3>
            </div>
            <p className="text-xs text-ink-muted leading-relaxed">
              Switch between Easy (generous gap for warmups), Medium (standard controlled tempo), and Hard (tight gaps demanding explosive speed).
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
