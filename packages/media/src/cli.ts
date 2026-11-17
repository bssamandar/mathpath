/**
 * `node node_modules/@mathpath/media/dist/cli.js provision`, run by
 * infra/deploy.sh inside the API image. See provision.ts.
 */
import { provisionStorage } from './provision';

const command = process.argv[2] ?? 'provision';
if (command !== 'provision') {
  console.error(`Unknown command: ${command}`);
  process.exit(2);
}
provisionStorage(process.env)
  .then((message) => console.warn(message))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
