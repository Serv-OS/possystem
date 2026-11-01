// 5.12.10 hero slideshow: which slides exist, the timing, and the server markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heroSlides, slideSeconds, nextSlide } from './blocks/heroSlides.js';

test('heroSlides: the hero fields are slide 1, extra slides need a photo or a headline, junk is dropped, 9 extra at most', () => {
  const one = heroSlides({ headline: 'Hi', photo_url: 'https://x/a.jpg', primary: { label: 'Order', href: 'servos:order' } });
  assert.equal(one.length, 1);
  assert.equal(one[0].photo, 'https://x/a.jpg');
  assert.equal(one[0].primary.label, 'Order');
  const many = heroSlides({ headline: 'Hi', slides: [
    { photo_url: 'https://x/b.jpg', headline: 'Two', button_label: 'Book', button_href: 'servos:book' },
    { headline: '  ' },
    null,
    'junk',
    { photo_url: 'javascript:alert(1)', headline: 'Three' },
    ...Array.from({ length: 12 }, (_, i) => ({ headline: `S${i}` })),
  ] });
  assert.equal(many.length, 10, 'slide 1 plus 9');
  assert.equal(many[1].headline, 'Two');
  assert.deepEqual(many[1].primary, { label: 'Book', href: 'servos:book' });
  assert.equal(many[2].photo, '', 'a javascript: photo is not a photo');
  assert.equal(many[2].headline, 'Three');
  const fallback = heroSlides({}, { fallbackPhoto: 'https://x/brand.jpg', fallbackHeadline: 'Mozz' });
  assert.equal(fallback[0].photo, 'https://x/brand.jpg');
  assert.equal(fallback[0].headline, 'Mozz');
  assert.equal(heroSlides(null).length, 1);
});

test('slideSeconds: 6 by default, 0 means no auto play, junk is 6; nextSlide wraps', () => {
  assert.equal(slideSeconds({}), 6);
  assert.equal(slideSeconds({ slide_seconds: '0' }), 0);
  assert.equal(slideSeconds({ slide_seconds: 8 }), 8);
  assert.equal(slideSeconds({ slide_seconds: '99' }), 6);
  assert.equal(nextSlide(0, 3), 1);
  assert.equal(nextSlide(2, 3), 0);
  assert.equal(nextSlide(5, 0), 0);
});
