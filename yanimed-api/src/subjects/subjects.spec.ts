import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { SubjectsController } from './subjects.controller.js';
import { SubjectsService } from './subjects.service.js';

describe('Subject creation HTTP contract', () => {
  let app: INestApplication;
  const create = vi.fn();
  const duplicateError = () => new Prisma.PrismaClientKnownRequestError('private duplicate details', {
    code: 'P2002', clientVersion: Prisma.prismaVersion.client,
    meta: { modelName: 'Subject', target: 'Subject_name_lower_key' },
  });

  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'test');
    create.mockReset().mockImplementation(async ({ data }) => ({ id: 'server-generated-id', ...data }));
    const module = await Test.createTestingModule({
      controllers: [SubjectsController],
      providers: [SubjectsService, { provide: PrismaService, useValue: { subject: { create } } }],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(async () => { await app?.close(); vi.unstubAllEnvs(); });
  const post = (body: unknown) => request(app.getHttpServer()).post('/subjects')
    .set('Host', 'localhost:3000').send(body as object);

  it('trims the name, persists metadata, and returns the server ID', async () => {
    const res = await post({ name: '  Anatomy  ' }).expect(201);
    expect(res.body).toEqual({ id: 'server-generated-id', name: 'Anatomy', subjectStatus: 'INCOMPLETE', chatAvailable: false });
    expect(create).toHaveBeenCalledWith({ data: { name: 'Anatomy' } });
  });
  it.each([{}, { name: '' }, { name: ' \t\n ' }, { name: null }, { name: 42 },
    { name: [] }, { name: {} }, { name: 'Anatomy', id: 'client-id' }])('rejects invalid input %j', async (body) => {
    await post(body).expect(400);
    expect(create).not.toHaveBeenCalled();
  });
  it('maps database rejection of pediatrics after Pediatrics to a sanitized 409', async () => {
    await post({ name: 'Pediatrics' }).expect(201);
    create.mockRejectedValueOnce(duplicateError());
    const res = await post({ name: 'pediatrics' }).expect(409);
    expect(res.body.message).toBe('A subject with this name already exists.');
    expect(JSON.stringify(res.body)).not.toContain('private duplicate details');
  });
  it('returns one 201 and one 409 for concurrent requests when the database rejects the loser', async () => {
    create.mockResolvedValueOnce({ id: 'winner', name: 'Pediatrics' }).mockRejectedValueOnce(duplicateError());
    const results = await Promise.all([post({ name: 'Pediatrics' }), post({ name: 'pediatrics' })]);
    expect(results.map(result => result.status).sort()).toEqual([201, 409]);
    expect(create).toHaveBeenCalledTimes(2);
  });
  it.each(['\t Pediatrics \n', '\u00a0Pediatrics\ufeff'])('trims boundary whitespace before persistence', async (name) => {
    await post({ name }).expect(201);
    expect(create).toHaveBeenCalledWith({ data: { name: 'Pediatrics' } });
  });
  it('sanitizes unexpected database failures', async () => {
    const error = new Error('private database details');
    create.mockRejectedValue(error);
    const res = await post({ name: 'Anatomy' }).expect(503);
    expect(JSON.stringify(res.body)).not.toContain(error.message);
  });
  it('does not translate unrelated Prisma errors into name conflicts', async () => {
    create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('private details', {
      code: 'P2021', clientVersion: Prisma.prismaVersion.client,
    }));
    const res = await post({ name: 'Anatomy' }).expect(503);
    expect(JSON.stringify(res.body)).not.toContain('private details');
  });
});
