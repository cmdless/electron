// an Adaptive Cards host config in Mantine's colors and type, light or dark
export function defaultHostConfig(scheme: 'light' | 'dark') {
  const dark = scheme === 'dark';
  const text = dark ? '#C9C9C9' : '#000000';
  const subtle = dark ? '#828282' : '#868E96';
  const color = (main: string) => ({ default: main, subtle });
  return {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    spacing: { small: 4, default: 8, medium: 16, large: 24, extraLarge: 32, padding: 16 },
    separator: { lineThickness: 1, lineColor: dark ? '#424242' : '#DEE2E6' },
    fontSizes: { small: 12, default: 14, medium: 16, large: 20, extraLarge: 26 },
    fontWeights: { lighter: 300, default: 400, bolder: 600 },
    containerStyles: {
      default: {
        backgroundColor: dark ? '#242424' : '#FFFFFF',
        foregroundColors: {
          default: color(text),
          accent: color(dark ? '#4DABF7' : '#228BE6'),
          good: color(dark ? '#69DB7C' : '#40C057'),
          warning: color(dark ? '#FFD43B' : '#FAB005'),
          attention: color(dark ? '#FF8787' : '#FA5252'),
          dark: color(text),
          light: color(subtle),
        },
      },
      emphasis: {
        backgroundColor: dark ? '#2E2E2E' : '#F8F9FA',
        foregroundColors: { default: color(text) },
      },
    },
    actions: { maxActions: 6, spacing: 'default', buttonSpacing: 8, actionsOrientation: 'horizontal', actionAlignment: 'right' },
    inputs: { label: { requiredInputs: { suffix: ' *' }, optionalInputs: {} } },
  };
}
