export class KalmanFilter {
  private x: [number, number];
  private P: [[number, number], [number, number]];
  private Q: [[number, number], [number, number]];
  private R: number;
  private dt: number;

  constructor() {
    this.x = [0, 0];
    this.P = [[1e-4, 0], [0, 1e-4]];
    this.Q = [[1e-9, 0], [0, 1e-8]];
    this.R = 1e-8;
    this.dt = 1.0;
  }

  update(z: number): number {
    const dt = this.dt;

    // Predict
    const x0_pred = this.x[0] + dt * this.x[1];
    const x1_pred = this.x[1];
    const P00_pred = this.P[0][0] + dt * this.P[0][1] + dt * this.P[1][0] + dt * dt * this.P[1][1] + this.Q[0][0];
    const P01_pred = this.P[0][1] + dt * this.P[1][1] + this.Q[0][1];
    const P10_pred = this.P[1][0] + dt * this.P[1][1] + this.Q[1][0];
    const P11_pred = this.P[1][1] + this.Q[1][1];

    // Innovation
    const y = z - x0_pred;
    const S = P00_pred + this.R;

    // Kalman gain
    const K0 = P00_pred / S;
    const K1 = P10_pred / S;

    // Update state
    this.x = [x0_pred + K0 * y, x1_pred + K1 * y];

    // Update covariance
    this.P = [
      [(1 - K0) * P00_pred, (1 - K0) * P01_pred],
      [P10_pred - K1 * P00_pred, P11_pred - K1 * P01_pred],
    ];

    return this.x[0];
  }

  reset(pos: number) {
    this.x = [pos, 0];
    this.P = [[1e-4, 0], [0, 1e-4]];
  }
}
