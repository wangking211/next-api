import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';

interface Row {
  name: string;
  id: number;
}

const cols = [
  { label: 'name', value: (r: Row) => r.name },
  { label: 'id', value: (r: Row) => r.id },
];

describe('toCsv', () => {
  it('输出表头 + 每行一列顺序与定义一致', () => {
    const rows: Row[] = [
      { name: 'a', id: 1 },
      { name: 'b', id: 2 },
    ];
    expect(toCsv(cols, rows)).toBe('name,id\na,1\nb,2');
  });

  it('空行集只输出表头（导出空列表不留空文件）', () => {
    expect(toCsv(cols, [])).toBe('name,id');
  });

  it('含逗号 / 引号 / 换行的值按 RFC 4180 加引号并把引号翻倍', () => {
    const rows = [
      { name: 'a,b', id: 1 },
      { name: 'say "hi"', id: 2 },
      { name: 'line1\nline2', id: 3 },
      { name: 'plain', id: 4 },
    ];
    expect(toCsv(cols, rows)).toBe(
      'name,id\n' + '"a,b",1\n' + '"say ""hi""",2\n' + '"line1\nline2",3\n' + 'plain,4',
    );
  });

  it('null / undefined / 非字符串值都落成字符串', () => {
    const valueCols = [
      { label: 'a', value: () => null },
      { label: 'b', value: () => undefined },
      { label: 'c', value: () => 0 },
      { label: 'd', value: () => false },
    ];
    expect(toCsv(valueCols, [{}])).toBe('a,b,c,d\n,,0,false');
  });
});
