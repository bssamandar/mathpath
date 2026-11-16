import { describe, expect, it } from 'vitest';
import { barHeights, nextWeek, pinProblem, previousWeek, rightShare, trend } from './report';

describe('weekly report helpers', () => {
  it('compares this week with the last', () => {
    expect(trend({ minutesActive: 0, minutesLastWeek: 0 })).toBe('none');
    expect(trend({ minutesActive: 30, minutesLastWeek: 0 })).toBe('first');
    expect(trend({ minutesActive: 105, minutesLastWeek: 100 })).toBe('same');
    expect(trend({ minutesActive: 130, minutesLastWeek: 100 })).toBe('up');
    expect(trend({ minutesActive: 40, minutesLastWeek: 100 })).toBe('down');
  });

  it('gives the share right on the first try', () => {
    expect(rightShare({ questionsAnswered: 0, rightFirstTime: 0 })).toBeNull();
    expect(rightShare({ questionsAnswered: 8, rightFirstTime: 6 })).toBe(75);
  });

  it('moves between weeks without passing this one', () => {
    expect(previousWeek('2026-11-16')).toBe('2026-11-09');
    expect(nextWeek('2026-11-09', '2026-11-16')).toBe('2026-11-16');
    expect(nextWeek('2026-11-16', '2026-11-16')).toBeNull();
  });

  it('scales bars to the busiest day', () => {
    expect(barHeights([0, 10, 20, 0, 0, 0, 5])).toEqual([0, 50, 100, 0, 0, 0, 25]);
    expect(barHeights([0, 0, 0, 0, 0, 0, 0])).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('refuses a PIN that is easy to guess', () => {
    expect(pinProblem('12a4')).toBe('format');
    expect(pinProblem('123')).toBe('format');
    expect(pinProblem('1111')).toBe('simple');
    expect(pinProblem('1234')).toBe('simple');
    expect(pinProblem('9876')).toBe('simple');
    expect(pinProblem('1212')).toBe('simple');
    expect(pinProblem('123123')).toBe('simple');
    expect(pinProblem('2580')).toBeNull();
  });
});
