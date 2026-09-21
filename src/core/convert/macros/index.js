import { registerPanelMacros } from './panels.js';
import { registerExpandMacro } from './expand.js';
import { registerTabsMacros } from './tabs.js';
import { registerCodeMacro } from './codeBlock.js';
import { registerStatusMacro } from './status.js';
import { registerLayoutMacros } from './layout.js';
import { registerEtfaiMacros } from './etfai.js';

registerPanelMacros();
registerExpandMacro();
registerTabsMacros();
registerCodeMacro();
registerStatusMacro();
registerLayoutMacros();
registerEtfaiMacros();
