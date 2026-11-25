/* How webpack builds the LG webOS app (`--env platform=webos`): appinfo.json with the version next to the app, and the two icons. */
const path = require('path');

const here = (file) => path.resolve(__dirname, file);

module.exports = {
  // Drawn from logo.svg at build time (scripts/platform-icons.js): 80 px on the launcher, 130 px large.
  icons: [
    { file: 'icon.png', size: 80 },
    { file: 'largeIcon.png', size: 130 },
  ],
  // The trial builds read the TV's unique id (the licence): their appinfo.json asks for it.
  copy: ({ version, trial }) => [
    {
      from: here('appinfo.json'),
      to: 'appinfo.json',
      transform: (content) => {
        const info = JSON.parse(content.toString().replace(/__VERSION__/g, version));
        if (trial) info.requiredACG = (info.requiredACG || []).concat(['deviceid.query']);
        return `${JSON.stringify(info, null, 2)}\n`;
      },
    },
  ],
};
