import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOMServer from 'react-dom/server';
import {
  Modal,
  ModalBackdrop,
  ModalContainer,
  ModalDialog,
  ModalHeader,
  ModalHeading,
  ModalBody,
  ModalFooter,
  ModalCloseTrigger
} from '@heroui/react';
import { modalVariants } from '@heroui/styles';

describe('HeroUI Modal Compound Components & Migration Verification', () => {
  it('exports all compound modal components from @heroui/react', () => {
    assert.ok(Modal, 'Modal must be exported');
    assert.strictEqual(typeof Modal, 'function', 'Modal should be a component function');

    assert.ok(ModalBackdrop, 'ModalBackdrop must be exported');
    assert.strictEqual(typeof ModalBackdrop, 'function', 'ModalBackdrop should be a component function');

    assert.ok(ModalContainer, 'ModalContainer must be exported');
    assert.strictEqual(typeof ModalContainer, 'function', 'ModalContainer should be a component function');

    assert.ok(ModalDialog, 'ModalDialog must be exported');
    assert.strictEqual(typeof ModalDialog, 'function', 'ModalDialog should be a component function');

    assert.ok(ModalHeader, 'ModalHeader must be exported');
    assert.strictEqual(typeof ModalHeader, 'function', 'ModalHeader should be a component function');

    assert.ok(ModalHeading, 'ModalHeading must be exported');
    assert.strictEqual(typeof ModalHeading, 'function', 'ModalHeading should be a component function');

    assert.ok(ModalBody, 'ModalBody must be exported');
    assert.strictEqual(typeof ModalBody, 'function', 'ModalBody should be a component function');

    assert.ok(ModalFooter, 'ModalFooter must be exported');
    assert.strictEqual(typeof ModalFooter, 'function', 'ModalFooter should be a component function');

    assert.ok(ModalCloseTrigger, 'ModalCloseTrigger must be exported');
    assert.strictEqual(typeof ModalCloseTrigger, 'function', 'ModalCloseTrigger should be a component function');
  });

  it('generates expected HeroUI / Tailwind BEM classes for modalVariants', () => {
    const slots = modalVariants();
    assert.ok(slots.backdrop().includes('modal__backdrop'), 'Backdrop slot must contain modal__backdrop');
    assert.ok(slots.container().includes('modal__container'), 'Container slot must contain modal__container');
    assert.ok(slots.dialog().includes('modal__dialog'), 'Dialog slot must contain modal__dialog');
    assert.ok(slots.header().includes('modal__header'), 'Header slot must contain modal__header');
    assert.ok(slots.body().includes('modal__body'), 'Body slot must contain modal__body');
    assert.ok(slots.footer().includes('modal__footer'), 'Footer slot must contain modal__footer');

    const xsVariants = modalVariants({ size: 'xs' });
    assert.ok(xsVariants.dialog().includes('modal__dialog--xs'), 'XS size dialog must include modal__dialog--xs');

    const smVariants = modalVariants({ size: 'sm' });
    assert.ok(smVariants.dialog().includes('modal__dialog--sm'), 'Small size dialog must include modal__dialog--sm');

    const mdVariants = modalVariants({ size: 'md' });
    assert.ok(mdVariants.dialog().includes('modal__dialog--md'), 'Medium size dialog must include modal__dialog--md');

    const lgVariants = modalVariants({ size: 'lg' });
    assert.ok(lgVariants.dialog().includes('modal__dialog--lg'), 'Large size dialog must include modal__dialog--lg');

    const scrollInside = modalVariants({ scroll: 'inside' });
    assert.ok(scrollInside.dialog().includes('modal__dialog--scroll-inside'), 'Inside scroll dialog must include modal__dialog--scroll-inside');

    const scrollOutside = modalVariants({ scroll: 'outside' });
    assert.ok(scrollOutside.dialog().includes('modal__dialog--scroll-outside'), 'Outside scroll dialog must include modal__dialog--scroll-outside');

    const blurBackdrop = modalVariants({ variant: 'blur' });
    assert.ok(blurBackdrop.backdrop().includes('modal__backdrop--blur'), 'Blur variant backdrop must include modal__backdrop--blur');

    const transparentBackdrop = modalVariants({ variant: 'transparent' });
    assert.ok(transparentBackdrop.backdrop().includes('modal__backdrop--transparent'), 'Transparent variant must include modal__backdrop--transparent');
  });

  it('renders ModalDialog and compound subcomponents with accessible roles and slots', () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(
        ModalDialog,
        { className: 'custom-dialog-class max-w-2xl bg-slate-900' },
        React.createElement(
          ModalHeader,
          { className: 'custom-header' },
          React.createElement(ModalHeading, null, 'Catalog Health Diagnostic')
        ),
        React.createElement(
          ModalBody,
          { className: 'custom-body' },
          'Inspecting 120 CAN commands and 45 automation triggers'
        ),
        React.createElement(
          ModalFooter,
          { className: 'custom-footer' },
          React.createElement('button', { type: 'button' }, 'Close')
        )
      )
    );

    // Verify accessibility attributes
    assert.ok(html.includes('role="dialog"'), 'ModalDialog must render role="dialog"');
    assert.ok(html.includes('tabindex="-1"'), 'ModalDialog must render tabindex="-1"');
    assert.ok(html.includes('aria-labelledby="'), 'ModalDialog must associate aria-labelledby with ModalHeading');
    assert.ok(html.includes('slot="title"'), 'ModalHeading must designate slot="title"');

    // Verify slots
    assert.ok(html.includes('data-slot="modal-dialog"'), 'Must have modal-dialog slot');
    assert.ok(html.includes('data-slot="modal-header"'), 'Must have modal-header slot');
    assert.ok(html.includes('data-slot="modal-heading"'), 'Must have modal-heading slot');
    assert.ok(html.includes('data-slot="modal-body"'), 'Must have modal-body slot');
    assert.ok(html.includes('data-slot="modal-footer"'), 'Must have modal-footer slot');

    // Verify custom classes preserved
    assert.ok(html.includes('custom-dialog-class'), 'Must preserve custom dialog classes');
    assert.ok(html.includes('max-w-2xl'), 'Must preserve Tailwind sizing classes');
    assert.ok(html.includes('bg-slate-900'), 'Must preserve background styling');
    assert.ok(html.includes('custom-header'), 'Must preserve custom header class');
    assert.ok(html.includes('custom-body'), 'Must preserve custom body class');
    assert.ok(html.includes('custom-footer'), 'Must preserve custom footer class');

    // Verify text content
    assert.ok(html.includes('Catalog Health Diagnostic'), 'Must render title text');
    assert.ok(html.includes('Inspecting 120 CAN commands'), 'Must render body text');
  });
});
