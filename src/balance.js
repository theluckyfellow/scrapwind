import * as THREE from 'three';

// Weight-sharing maths, used for both wheel springs (Blueprint) and rotor lift (FlightController).

const MIN_SHARE = 0.25; // nobody carries less than a quarter of an even share

/**
 * Splits a total force between supports at (x, z) so the shares add up to the total and neither tips the
 * body about the balance point at (balanceX, balanceZ): the smallest set of shares that does it,
 * F = Aᵀ (A Aᵀ)⁻¹ b with rows [1, x, z]. Three supports have exactly one answer; more share it out evenly.
 * Supports all in a line can't balance both ways, so they split evenly.
 */
export function balancedShares(supports, balanceX, balanceZ, total) {
  const count = supports.length;
  if (count === 0) return [];
  const even = new Array(count).fill(total / count);
  if (count < 3) return even;
  let sumX = 0, sumZ = 0, sumXX = 0, sumXZ = 0, sumZZ = 0;
  for (const [x, z] of supports) {
    sumX += x; sumZ += z; sumXX += x * x; sumXZ += x * z; sumZZ += z * z;
  }
  const matrix = new THREE.Matrix3().set(count, sumX, sumZ, sumX, sumXX, sumXZ, sumZ, sumXZ, sumZZ);
  if (Math.abs(matrix.determinant()) < 1e-6) return even;
  const multipliers = new THREE.Vector3(total, total * balanceX, total * balanceZ).applyMatrix3(matrix.invert());
  const shares = supports.map(([x, z]) => multipliers.x + multipliers.y * x + multipliers.z * z);
  // A support far from the balance point can come out light or negative: give everyone a floor, keep the total.
  const floor = (total / count) * MIN_SHARE;
  const floored = shares.map(share => Math.max(share, floor));
  const sum = floored.reduce((accumulated, share) => accumulated + share, 0);
  return floored.map(share => (share * total) / sum);
}
