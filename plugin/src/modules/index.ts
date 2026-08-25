import type { OpenArkModule } from "../core/types.js";
import { memoryModule } from "./memory.js";
import { personalityModule } from "./personality.js";
import { reflectionModule } from "./reflection.js";
import { skillsModule } from "./skills.js";

export const allModules: OpenArkModule[] = [
  memoryModule,
  personalityModule,
  reflectionModule,
  skillsModule,
];

export { memoryModule, personalityModule, reflectionModule, skillsModule };
