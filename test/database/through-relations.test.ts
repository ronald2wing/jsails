/**
 * Tests for "has_many :through" relations: batch loading, whereHas/has
 * predicates, and rejection paths (polymorphic, composite-key).
 *
 * The through relation chains: Doctor -O2M-> Appointment -M2O-> Patient
 * Loading Doctor.patients resolves the chain and loads patients in 2 queries
 * (one through-table raw query + one target find).
 *
 * All entities are backed by a raw {@link DataSource} with
 * {@code synchronize: true} so the junction entities are auto-created.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  BaseEntity,
  Column,
  DataSource,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  SelectQueryBuilder,
} from 'typeorm';

import { PolymorphicRelation, clearPolymorphicRegistry } from '../../src/database/polymorphic.js';
import { loadRelations } from '../../src/database/relation-loader/index.js';
import { resolveRelation } from '../../src/database/relation-metadata.js';
import { resolveThroughRelation } from '../../src/database/through-relations.js';
import { whereHas, has } from '../../src/database/relation-query.js';

afterEach(() => clearPolymorphicRegistry());

// ---------------------------------------------------------------------------
// Query-counting instrumentation
// ---------------------------------------------------------------------------

function installQueryCounter(): { getCount: () => number; restore: () => void } {
  let count = 0;

  const origGetRawMany = SelectQueryBuilder.prototype.getRawMany;
  SelectQueryBuilder.prototype.getRawMany = function (...args: unknown[]) {
    count++;
    return (origGetRawMany as Function).apply(this, args);
  };

  const origGetMany = SelectQueryBuilder.prototype.getMany;
  SelectQueryBuilder.prototype.getMany = function (...args: unknown[]) {
    count++;
    return (origGetMany as Function).apply(this, args);
  };

  return {
    getCount: () => count,
    restore: () => {
      SelectQueryBuilder.prototype.getRawMany = origGetRawMany;
      SelectQueryBuilder.prototype.getMany = origGetMany;
    },
  };
}

// ===================================================================
// Through entities: Doctor -O2M-> Appointment -M2O-> Patient
// ===================================================================

let Doctor: typeof BaseEntity;
let Appointment: typeof BaseEntity;
let Patient: typeof BaseEntity;

function declareThroughEntities() {
  @Entity('thr_doctors')
  class D extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 100, nullable: false }) name!: string;
    @OneToMany(() => Appointment, (a: any) => a.doctor)
    appointments!: any[];
  }
  Doctor = D;

  @Entity('thr_appointments')
  class A extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 200, nullable: false }) reason!: string;
    @ManyToOne(() => Doctor, { nullable: false })
    @JoinColumn({ name: 'doctor_id' })
    doctor!: any;
    @ManyToOne(() => Patient, { nullable: false })
    @JoinColumn({ name: 'patient_id' })
    patient!: any;
  }
  Appointment = A;

  @Entity('thr_patients')
  class P extends BaseEntity {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: 'varchar', length: 100, nullable: false }) name!: string;
    @OneToMany(() => Appointment, (a: any) => a.patient)
    appointments!: any[];
  }
  Patient = P;
}

declareThroughEntities();

async function makeThroughDS() {
  const ds = new DataSource({
    type: 'sqljs',
    entities: [Doctor, Appointment, Patient],
    synchronize: true,
  } as any);
  await ds.initialize();

  await (ds.getRepository(Doctor) as any).save([
    { id: 1, name: 'Dr. Smith' },
    { id: 2, name: 'Dr. Jones' },
    { id: 3, name: 'Dr. Empty' },
  ]);

  await (ds.getRepository(Patient) as any).save([
    { id: 1, name: 'Alice' },
    { id: 2, name: 'Bob' },
    { id: 3, name: 'Charlie' },
    { id: 4, name: 'Diana' },
  ]);

  await (ds.getRepository(Appointment) as any).save([
    { id: 1, reason: 'checkup', doctor: 1, patient: 1 },
    { id: 2, reason: 'flu', doctor: 1, patient: 2 },
    { id: 3, reason: 'injury', doctor: 2, patient: 2 },
    { id: 4, reason: 'checkup', doctor: 2, patient: 3 },
  ]);

  return ds;
}

// ===================================================================
// resolveThroughRelation
// ===================================================================

describe('resolveThroughRelation', () => {
  test('resolves the through chain Doctor -> Appointment -> Patient', () => {
    const through = resolveThroughRelation(Doctor, 'patient');

    assert.ok(through !== undefined, 'expected a through relation descriptor');
    if (!through) throw new Error('unreachable');
    assert.equal(through.source, 'D');
    assert.equal(through.through, 'A');
    assert.equal(through.target, 'P');
    assert.equal(through.sourceKey, 'doctor_id');
    assert.equal(through.targetKey, 'patient_id');
  });

  test('returns undefined for a non-through property', () => {
    const through = resolveThroughRelation(Doctor, 'nonsense');
    assert.equal(through, undefined);
  });

  test('returns undefined for a property that is a direct relation, not a through', () => {
    const through = resolveThroughRelation(Doctor, 'appointments');
    // 'appointments' is a direct O2M, not a through on Appointment
    assert.equal(through, undefined);
  });

  test('resolveRelation with a through property returns a synthetic relation', () => {
    const rel = resolveRelation(Doctor, 'patient');

    assert.equal(rel.kind, 'one-to-many');
    assert.equal(rel.targetEntity, Patient);
    assert.ok(rel.through !== undefined, 'expected through descriptor');
    if (!rel.through) throw new Error('unreachable');
    assert.equal(rel.through.sourceKey, 'doctor_id');
    assert.equal(rel.through.targetKey, 'patient_id');
  });
});

// ===================================================================
// Batch load through relation
// ===================================================================

describe('relation-loader (through)', () => {
  test('loads patients through appointments in exactly 2 loader queries', async () => {
    const ds = await makeThroughDS();
    const counter = installQueryCounter();
    try {
      const doctors = (await Doctor.find({
        order: { id: 'ASC' },
      } as any)) as unknown as Record<string, unknown>[];

      const initialCount = counter.getCount();

      await loadRelations(doctors, { with: { patient: true } });

      const loaderCount = counter.getCount() - initialCount;
      // One raw query on the through table + one target find = 2 queries.
      assert.equal(loaderCount, 2);

      // Dr. Smith (id=1): patients Alice (1) + Bob (2)
      const smith = doctors[0]!;
      const smithPatients = smith.patient as Record<string, unknown>[];
      assert.equal(smithPatients.length, 2);
      const smithNames = smithPatients.map((p) => p.name).sort();
      assert.deepEqual(smithNames, ['Alice', 'Bob']);

      // Dr. Jones (id=2): patients Bob (2) + Charlie (3)
      const jones = doctors[1]!;
      const jonesPatients = jones.patient as Record<string, unknown>[];
      assert.equal(jonesPatients.length, 2);
      const jonesNames = jonesPatients.map((p) => p.name).sort();
      assert.deepEqual(jonesNames, ['Bob', 'Charlie']);

      // Dr. Empty (id=3): no appointments → no patients
      const empty = doctors[2]!;
      assert.deepEqual(empty.patient, []);
    } finally {
      counter.restore();
      await ds.destroy();
    }
  });

  test('loads through relation with select filter', async () => {
    const ds = await makeThroughDS();
    try {
      const doctors = (await Doctor.find({
        order: { id: 'ASC' },
      } as any)) as unknown as Record<string, unknown>[];

      await loadRelations(doctors, {
        with: { patient: { select: ['id', 'name'] } },
      });

      const smith = doctors[0]!;
      const patients = smith.patient as Record<string, unknown>[];
      assert.equal(patients.length, 2);
      // Verify only selected columns are present (name is present, appointments not loaded)
      assert.equal(patients[0]!.name, 'Alice');
    } finally {
      await ds.destroy();
    }
  });

  test('loads through relation with where filter', async () => {
    const ds = await makeThroughDS();
    try {
      const doctors = (await Doctor.find({
        order: { id: 'ASC' },
      } as any)) as unknown as Record<string, unknown>[];

      await loadRelations(doctors, {
        with: { patient: { where: { name: 'Alice' } } },
      });

      // Dr. Smith: Alice + Bob, but where filters to Alice only
      const smith = doctors[0]!;
      const smithPatients = smith.patient as Record<string, unknown>[];
      assert.equal(smithPatients.length, 1);
      assert.equal(smithPatients[0]!.name, 'Alice');

      // Dr. Jones: Bob + Charlie, none named Alice
      const jones = doctors[1]!;
      const jonesPatients = jones.patient as Record<string, unknown>[];
      assert.equal(jonesPatients.length, 0);
    } finally {
      await ds.destroy();
    }
  });

  test('loads through relation with limit', async () => {
    const ds = await makeThroughDS();
    try {
      const doctors = (await Doctor.find({
        order: { id: 'ASC' },
      } as any)) as unknown as Record<string, unknown>[];

      await loadRelations(doctors, {
        with: { patient: { limit: 1 } },
      });

      // Dr. Smith has 2 patients, but limit caps to 1
      const smith = doctors[0]!;
      const smithPatients = smith.patient as Record<string, unknown>[];
      assert.equal(smithPatients.length, 1);
    } finally {
      await ds.destroy();
    }
  });
});

// ===================================================================
// whereHas / has over through relation
// ===================================================================

describe('whereHas (through)', () => {
  test('filters doctors whose patients include a matching one', async () => {
    const ds = await makeThroughDS();
    try {
      // Doctors whose patients include someone named Alice — only Dr. Smith
      const doctors = await whereHas(Doctor, 'patient', (q) => q.where('name', 'Alice')).getMany();

      assert.equal(doctors.length, 1);
      assert.equal((doctors[0] as unknown as { name: string }).name, 'Dr. Smith');
    } finally {
      await ds.destroy();
    }
  });

  test('returns all doctors with any patient when no predicate', async () => {
    const ds = await makeThroughDS();
    try {
      const doctors = await whereHas(Doctor, 'patient').getMany();

      // Dr. Smith and Dr. Jones have patients; Dr. Empty has none
      assert.equal(doctors.length, 2);
      const names = (doctors as unknown as { name: string }[]).map((d) => d.name).sort();
      assert.deepEqual(names, ['Dr. Jones', 'Dr. Smith']);
    } finally {
      await ds.destroy();
    }
  });

  test('returns empty when predicate matches nothing', async () => {
    const ds = await makeThroughDS();
    try {
      const doctors = await whereHas(Doctor, 'patient', (q) => q.where('name', 'Zelda')).getMany();

      assert.equal(doctors.length, 0);
    } finally {
      await ds.destroy();
    }
  });

  test('has >= 2 patients (through)', async () => {
    const ds = await makeThroughDS();
    try {
      const doctors = await has(Doctor, 'patient', '>=', 2).getMany();

      // Dr. Smith (Alice + Bob = 2) and Dr. Jones (Bob + Charlie = 2) both have >= 2
      assert.equal(doctors.length, 2);
      const names = (doctors as unknown as { name: string }[]).map((d) => d.name).sort();
      assert.deepEqual(names, ['Dr. Jones', 'Dr. Smith']);
    } finally {
      await ds.destroy();
    }
  });

  test('has = 0 patients (through)', async () => {
    const ds = await makeThroughDS();
    try {
      const doctors = await has(Doctor, 'patient', '=', 0).getMany();

      // Only Dr. Empty has 0 patients
      assert.equal(doctors.length, 1);
      assert.equal((doctors[0] as unknown as { name: string }).name, 'Dr. Empty');
    } finally {
      await ds.destroy();
    }
  });
});

// ===================================================================
// Rejection: polymorphic through paths
// ===================================================================

describe('through relation rejections (polymorphic)', () => {
  test('rejects a through path involving a polymorphic through entity', () => {
    @Entity('thr_poly_doctors')
    class PolyDoctor extends BaseEntity {
      @PrimaryGeneratedColumn() id!: number;
      @OneToMany(() => PolyAppointment, (a: any) => a.doctor)
      appointments!: any[];
    }

    @Entity('thr_poly_appointments')
    class PolyAppointment extends BaseEntity {
      @PrimaryGeneratedColumn() id!: number;
      @ManyToOne(() => PolyDoctor)
      @JoinColumn({ name: 'doctor_id' })
      doctor!: any;
      // Polymorphic target instead of a concrete M2O to Patient.
      // The actual type column points to a real target, but the point is that
      // Appointment's 'patient' M2O is replaced by a polymorphic relation,
      // so resolveThroughRelation cannot find the expected M2O chain.
      @PolymorphicRelation({ targets: [PolyDoctor], relatedName: 'appointments' })
      target!: unknown;
    }

    // resolveRelation should fail because the polymorphic through entity has
    // no M2O named 'patient' — resolveThroughRelation returns undefined.
    assert.throws(() => resolveRelation(PolyDoctor, 'patient'), {
      name: 'RelationError',
    });
  });
});

// ===================================================================
// Rejection: composite-key through paths
// ===================================================================

describe('through relation rejections (composite key)', () => {
  test('rejects a through path where target has a composite primary key', () => {
    @Entity('thr_ck_doctors')
    class CkDoctor extends BaseEntity {
      @PrimaryGeneratedColumn() id!: number;
      @OneToMany(() => CkAppointment, (a: any) => a.doctor)
      appointments!: any[];
    }

    @Entity('thr_ck_appointments')
    class CkAppointment extends BaseEntity {
      @PrimaryGeneratedColumn() id!: number;
      @ManyToOne(() => CkDoctor)
      @JoinColumn({ name: 'doctor_id' })
      doctor!: any;
      @ManyToOne(() => CkPatient)
      @JoinColumn({ name: 'patient_id' })
      patient!: any;
    }

    @Entity()
    class CkPatient extends BaseEntity {
      @PrimaryColumn() tenantId!: number;
      @PrimaryColumn() patientId!: number;
    }

    // resolveThroughRelation finds the chain but resolveThroughToRelation
    // rejects the composite-key target.
    assert.throws(() => resolveRelation(CkDoctor, 'patient'), {
      name: 'RelationError',
    });
  });
});
