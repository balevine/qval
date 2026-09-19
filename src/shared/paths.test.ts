import { describe, expect, it } from 'vitest'
import { defaultEvalPath, evalSearchDirs, reportPathFor, suggestEvalName } from '@lib/paths.mjs'

describe('suggestEvalName', () => {
  it('derives <stem>.qval.json from the dataset path', () => {
    expect(suggestEvalName('/x/tickets.json')).toBe('tickets.qval.json')
    expect(suggestEvalName('/x/zendesk-export-q3.json')).toBe('zendesk-export-q3.qval.json')
    // Already an eval file: the `.qval` isn't doubled up.
    expect(suggestEvalName('/x/run1.qval.json')).toBe('run1.qval.json')
    expect(suggestEvalName(null)).toBe('evaluation.qval.json')
  })
})

describe('reportPathFor', () => {
  it('writes the report beside the working file, never inside it', () => {
    expect(reportPathFor('/x/tickets.qval.json')).toBe('/x/tickets.report.json')
    expect(reportPathFor('/x/y/run1.qval.json')).toBe('/x/y/run1.report.json')
  })
})

describe('defaultEvalPath', () => {
  const none = () => false

  it('puts a new eval file in qval-output/', () => {
    expect(defaultEvalPath('/w', '/w/tickets.json', none)).toBe('/w/qval-output/tickets.qval.json')
    // Named after the dataset, wherever the dataset happens to live.
    expect(defaultEvalPath('/w', '/elsewhere/zendesk-q3.json', none)).toBe('/w/qval-output/zendesk-q3.qval.json')
  })

  it('keeps using one an older version left loose in the working directory', () => {
    // Otherwise upgrading starts a second, empty evaluation beside a full one, and the first sign
    // of it is a review that looks like it lost every score.
    const legacy = (p: string) => p === '/w/tickets.qval.json'
    expect(defaultEvalPath('/w', '/w/tickets.json', legacy)).toBe('/w/tickets.qval.json')
  })
})

describe('evalSearchDirs', () => {
  it('looks in qval-output/ first, then the working directory itself', () => {
    expect(evalSearchDirs('/w')).toEqual(['/w/qval-output', '/w'])
  })
})
