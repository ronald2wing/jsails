export default {
  service: 'jsails-verify',
  image: 'jsails-verify:local',
  services: {
    db: { type: 'mariadb' },
    valkey: { type: 'valkey' },
  },
  local: {
    ports: { db: 3306, valkey: 6379 },
  },
};
