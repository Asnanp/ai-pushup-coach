declare module '@mediapipe/tasks-vision' {
  export class FilesetResolver {
    static forVisionTasks(path: string): Promise<unknown>;
  }

  export class PoseLandmarker {
    static createFromOptions(fileset: unknown, options: unknown): Promise<PoseLandmarker>;
    detectForVideo(video: HTMLVideoElement, timestamp: number): PoseLandmarkerResult;
    close(): void;
  }

  export type PoseLandmarkerResult = {
    landmarks: Array<Array<{ x: number; y: number; z: number; visibility?: number }>>;
    worldLandmarks?: Array<Array<{ x: number; y: number; z: number; visibility?: number }>>;
  };
}
