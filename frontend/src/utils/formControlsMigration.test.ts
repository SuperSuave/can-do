import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOMServer from 'react-dom/server';
import {
  SearchField,
  Select,
  ListBox,
  ListBoxItem,
  Slider,
  TextField,
  Input
} from '@heroui/react';
import { searchFieldVariants, selectVariants, sliderVariants } from '@heroui/styles';

describe('HeroUI Form Controls Migration (Select, SearchField, Slider, TextField)', () => {
  it('exports all form compound components from @heroui/react', () => {
    assert.ok(SearchField, 'SearchField must be exported');
    assert.ok(SearchField.Group, 'SearchField.Group must be exported');
    assert.ok(SearchField.Input, 'SearchField.Input must be exported');
    assert.ok(SearchField.SearchIcon, 'SearchField.SearchIcon must be exported');
    assert.ok(SearchField.ClearButton, 'SearchField.ClearButton must be exported');

    assert.ok(Select, 'Select must be exported');
    assert.ok(Select.Trigger, 'Select.Trigger must be exported');
    assert.ok(Select.Value, 'Select.Value must be exported');
    assert.ok(Select.Indicator, 'Select.Indicator must be exported');
    assert.ok(Select.Popover, 'Select.Popover must be exported');

    assert.ok(ListBox, 'ListBox must be exported');
    assert.ok(ListBoxItem, 'ListBoxItem must be exported');

    assert.ok(Slider, 'Slider must be exported');
    assert.ok(Slider.Track, 'Slider.Track must be exported');
    assert.ok(Slider.Fill, 'Slider.Fill must be exported');
    assert.ok(Slider.Thumb, 'Slider.Thumb must be exported');

    assert.ok(TextField, 'TextField must be exported');
    assert.ok(Input, 'Input must be exported');
  });

  it('generates expected HeroUI / Tailwind BEM classes for form control variants', () => {
    const sfSlots = searchFieldVariants();
    assert.ok(sfSlots.base().includes('search-field'), 'SearchField base must include search-field');
    assert.ok(sfSlots.group().includes('search-field__group'), 'SearchField group must include search-field__group');
    assert.ok(sfSlots.input().includes('search-field__input'), 'SearchField input must include search-field__input');
    assert.ok(sfSlots.searchIcon().includes('search-field__search-icon'), 'SearchField searchIcon must include search-field__search-icon');
    assert.ok(sfSlots.clearButton().includes('search-field__clear-button'), 'SearchField clearButton must include search-field__clear-button');

    const selSlots = selectVariants();
    assert.ok(selSlots.base().includes('select'), 'Select base must include select');
    assert.ok(selSlots.trigger().includes('select__trigger'), 'Select trigger must include select__trigger');
    assert.ok(selSlots.value().includes('select__value'), 'Select value must include select__value');
    assert.ok(selSlots.indicator().includes('select__indicator'), 'Select indicator must include select__indicator');

    const slSlots = sliderVariants();
    assert.ok(slSlots.base().includes('slider'), 'Slider base must include slider');
    assert.ok(slSlots.track().includes('slider__track'), 'Slider track must include slider__track');
    assert.ok(slSlots.fill().includes('slider__fill'), 'Slider fill must include slider__fill');
    assert.ok(slSlots.thumb().includes('slider__thumb'), 'Slider thumb must include slider__thumb');
  });

  it('renders SearchField with accessible structure and search icon', () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(
        SearchField,
        {
          value: '0x1F5',
          onChange: () => {},
          'aria-label': 'Search commands',
          className: 'search-container'
        },
        React.createElement(
          SearchField.Group,
          { className: 'search-group' },
          React.createElement(SearchField.SearchIcon, { className: 'search-icon' }),
          React.createElement(SearchField.Input, {
            placeholder: 'Search CAN IDs...',
            className: 'search-input'
          }),
          React.createElement(SearchField.ClearButton, {
            className: 'search-clear',
            'aria-label': 'Clear'
          })
        )
      )
    );

    assert.ok(html.includes('data-slot="search-field"'), 'Must render search-field data-slot');
    assert.ok(html.includes('data-slot="search-field-group"'), 'Must render search-field-group data-slot');
    assert.ok(html.includes('data-slot="search-field-input"'), 'Must render search-field-input data-slot');
    assert.ok(html.includes('data-slot="search-field-search-icon"'), 'Must render search-field-search-icon');
    assert.ok(html.includes('data-slot="search-field-clear-button"'), 'Must render search-field-clear-button');
    assert.ok(html.includes('value="0x1F5"'), 'Must render active search value');
  });

  it('renders Select with Trigger, Value, Indicator, and ListBox items', () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(
        Select,
        {
          selectedKey: 'ev6',
          onSelectionChange: () => {},
          'aria-label': 'Select Vehicle',
          className: 'vehicle-select'
        },
        React.createElement(
          Select.Trigger,
          { className: 'trigger-btn' },
          React.createElement(Select.Value, { className: 'val-text' }),
          React.createElement(Select.Indicator, { className: 'indicator-icon' })
        ),
        React.createElement(
          Select.Popover,
          {
            className: 'popover-panel',
            children: React.createElement(
              ListBox,
              { className: 'listbox-menu' },
              React.createElement(ListBoxItem, { id: 'all', textValue: 'All Vehicles' }, 'All Vehicles'),
              React.createElement(ListBoxItem, { id: 'ev6', textValue: 'Kia EV6 GT' }, 'Kia EV6 GT'),
              React.createElement(ListBoxItem, { id: 'ioniq5', textValue: 'Ioniq 5 AWD' }, 'Ioniq 5 AWD')
            )
          }
        )
      )
    );

    assert.ok(html.includes('data-slot="select"'), 'Must render select data-slot');
    assert.ok(html.includes('data-slot="select-trigger"'), 'Must render select-trigger data-slot');
    assert.ok(html.includes('data-slot="select-value"'), 'Must render select-value data-slot');
    assert.ok(html.includes('Kia EV6 GT'), 'Must render selected key label in select value');
    assert.ok(html.includes('data-slot="select-default-indicator"'), 'Must render select indicator');
  });

  it('renders Slider with Track, Fill, and Thumb elements', () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(
        Slider,
        {
          minValue: 14,
          maxValue: 32,
          step: 0.5,
          value: 21.5,
          'aria-label': 'Climate Target Temperature',
          className: 'climate-slider'
        },
        React.createElement(
          Slider.Track,
          { className: 'track-bar' },
          React.createElement(Slider.Fill, { className: 'fill-bar' }),
          React.createElement(Slider.Thumb, { className: 'thumb-handle' })
        )
      )
    );

    assert.ok(html.includes('data-slot="slider"'), 'Must render slider data-slot');
    assert.ok(html.includes('data-slot="slider-track"'), 'Must render slider-track data-slot');
    assert.ok(html.includes('data-slot="slider-fill"'), 'Must render slider-fill data-slot');
    assert.ok(html.includes('data-slot="slider-thumb"'), 'Must render slider-thumb data-slot');
    assert.ok(html.includes('value="21.5"'), 'Must render thumb with active numeric value');
  });

  it('renders TextField with Input element', () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(
        TextField,
        {
          'aria-label': 'Automation Rule Name',
          defaultValue: 'Auto Precondition'
        },
        React.createElement(Input, { placeholder: 'Enter name' })
      )
    );

    assert.ok(html.includes('data-slot="textfield"'), 'Must render textfield data-slot');
    assert.ok(html.includes('data-slot="input"'), 'Must render input data-slot');
    assert.ok(html.includes('value="Auto Precondition"'), 'Must render text value');
  });
});

