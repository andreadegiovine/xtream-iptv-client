import { t } from '../i18n/index.js';

/** The label of an age rating: "All ages", "14+"; null (no limit, in the profile form): "No limit". */
export const ageLabel = (age) => (age === null || age === undefined ? t('profiles.noLimit') : age === 0 ? t('profiles.allAges') : `${age}+`);
