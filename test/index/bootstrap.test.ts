import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DataSource, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../../src/index.js';

@Entity()
class Widget extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;
}

describe('bootstrap', () => {
  it('exposes BaseEntity for Active Record entities', () => {
    assert.equal(typeof BaseEntity, 'function');
    assert.ok(Widget.prototype instanceof BaseEntity);
  });

  it('instantiates a postgres DataSource offline', () => {
    const dataSource = new DataSource({
      type: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      username: 'placeholder',
      password: 'placeholder',
      database: 'placeholder',
      entities: [Widget],
      synchronize: false,
    });

    assert.equal(dataSource.isInitialized, false);
    assert.equal(dataSource.options.type, 'postgres');
  });

  it('instantiates a mysql DataSource offline', () => {
    const dataSource = new DataSource({
      type: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      username: 'placeholder',
      password: 'placeholder',
      database: 'placeholder',
      entities: [Widget],
      synchronize: false,
    });

    assert.equal(dataSource.isInitialized, false);
    assert.equal(dataSource.options.type, 'mysql');
  });
});
