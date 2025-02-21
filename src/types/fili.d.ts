declare module 'fili' {
  export class Butterworth {
    constructor(options: {
      order: number;
      characteristic: string;
      Fs: number;
      Fc: number;
    });
    lowpass(): number[];
    highpass(): number[];
    multiStep(data: Float32Array, coeffs: number[]): Float32Array;
  }
} 