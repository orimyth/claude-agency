// Default agent → avatar mapping
// Gender: Alice(F), Bob(M), Charlie(M), Diana(F), Eve(F), Frank(M), Grace(F), Alex(M), Maya(F)
const DEFAULT_AVATARS: Record<string, string> = {
  ceo: "/avatars/female/f1.jpg",       // Alice
  hr: "/avatars/male/m1.jpg",          // Bob
  architect: "/avatars/male/m2.jpg",   // Charlie
  pm: "/avatars/female/f2.jpg",        // Diana
  developer: "/avatars/female/f3.jpg", // Eve
  designer: "/avatars/male/m3.jpg",    // Frank
  researcher: "/avatars/female/f4.jpg",// Grace
  "backend-developer": "/avatars/male/m4.jpg",   // Alex
  "frontend-developer": "/avatars/female/f5.jpg", // Maya
};

// Pool of unassigned avatars for new hires
const MALE_POOL = Array.from({ length: 15 }, (_, i) => `/avatars/male/m${i + 1}.jpg`);
const FEMALE_POOL = Array.from({ length: 15 }, (_, i) => `/avatars/female/f${i + 1}.jpg`);

const usedAvatars = new Set(Object.values(DEFAULT_AVATARS));

export function getAgentAvatar(agentId: string): string {
  return DEFAULT_AVATARS[agentId] ?? DEFAULT_AVATARS.ceo;
}

export function assignAvatar(agentId: string, gender: "male" | "female"): string {
  // Check if already assigned
  if (DEFAULT_AVATARS[agentId]) return DEFAULT_AVATARS[agentId];

  const pool = gender === "male" ? MALE_POOL : FEMALE_POOL;
  const available = pool.find((a) => !usedAvatars.has(a));

  if (available) {
    DEFAULT_AVATARS[agentId] = available;
    usedAvatars.add(available);
    return available;
  }

  // Fallback: use a random one from the pool
  const fallback = pool[Math.floor(Math.random() * pool.length)];
  DEFAULT_AVATARS[agentId] = fallback;
  return fallback;
}

export function getAllAvatarMappings(): Record<string, string> {
  return { ...DEFAULT_AVATARS };
}
