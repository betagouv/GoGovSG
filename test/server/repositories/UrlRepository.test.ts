import { S3 } from 'aws-sdk'
import {
  clicksModelMock,
  devicesModelMock,
  heatMapModelMock,
  mockQuery,
  mockTransaction,
  redisMockClient,
  sanitiseMock,
  urlModelMock,
} from '../api/util'
import { UrlRepository } from '../../../src/server/repositories/UrlRepository'
import { UrlMapper } from '../../../src/server/mappers/UrlMapper'
import { SearchResultsSortOrder } from '../../../src/shared/search'
import { FileVisibility, S3ServerSide } from '../../../src/server/services/aws'
import { NotFoundError } from '../../../src/server/util/error'
import { StorableUrlState } from '../../../src/server/repositories/enums'
import { DirectoryQueryConditions } from '../../../src/server/services/interfaces/DirectorySearchServiceInterface'

jest.mock('../../../src/server/models/url', () => ({
  Url: urlModelMock,
  sanitise: sanitiseMock,
}))

jest.mock('../../../src/server/models/statistics/daily', () => ({
  Clicks: clicksModelMock,
}))

jest.mock('../../../src/server/models/statistics/weekday', () => ({
  WeekdayClicks: heatMapModelMock,
}))

jest.mock('../../../src/server/models/statistics/devices', () => ({
  Devices: devicesModelMock,
}))

jest.mock('../../../src/server/redis', () => ({
  redirectClient: redisMockClient,
}))

jest.mock('../../../src/server/util/sequelize', () => ({
  transaction: mockTransaction,
  sequelize: { query: mockQuery, transaction: mockTransaction },
}))

const s3Client = new S3()
const s3Bucket = 'bucket'
const fileURLPrefix = 'prefix'

const fileBucket = new S3ServerSide(s3Client, s3Bucket, fileURLPrefix)

const repository = new UrlRepository(fileBucket, new UrlMapper())
const cacheGetSpy = jest.spyOn(redisMockClient, 'get')

describe('UrlRepository', () => {
  beforeEach(async () => {
    redisMockClient.flushall()
    cacheGetSpy.mockClear()
  })

  it('passes findByShortUrl through to Url.findOne', async () => {
    const findOne = jest.spyOn(urlModelMock, 'findOne')
    try {
      const shortUrl = 'abcdef'
      findOne.mockResolvedValue(null)
      await expect(repository.findByShortUrl(shortUrl)).resolves.toBeNull()
      expect(findOne).toHaveBeenCalledWith({ where: { shortUrl } })
    } finally {
      // Deliberately not call findOne.mockRestore(), as it seems
      // to permanently make it unmockable
    }
  })

  describe('create', () => {
    const create = jest.spyOn(urlModelMock, 'create')
    const putObject = jest.spyOn(s3Client, 'putObject')

    // @ts-ignore
    putObject.mockReturnValue({ promise: () => Promise.resolve() })

    const userId = 2
    const shortUrl = 'abcdef'
    const longUrl = 'https://www.agency.gov.sg'

    beforeEach(() => {
      create.mockReset()
      putObject.mockClear()
    })

    it('creates the specified longUrl', async () => {
      const storableUrl = {
        shortUrl,
        longUrl,
        state: 'ACTIVE',
        clicks: 2,
        isFile: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        description: 'An agency of the Singapore Government',
        contactEmail: 'contact-us@agency.gov.sg',
      }
      create.mockResolvedValue(storableUrl)
      await expect(
        repository.create({ userId, shortUrl, longUrl }),
      ).resolves.toStrictEqual(storableUrl)
      expect(create).toHaveBeenCalledWith(
        {
          longUrl,
          shortUrl,
          userId,
          isFile: false,
        },
        expect.anything(),
      )
      expect(putObject).not.toHaveBeenCalled()
    })

    it('creates the specified public file', async () => {
      const file = {
        data: Buffer.from(''),
        key: 'key',
        mimetype: 'text/csv',
      }
      const storableUrl = {
        shortUrl,
        longUrl: fileBucket.buildFileLongUrl(file.key),
        state: 'ACTIVE',
        clicks: 2,
        isFile: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        description: 'An agency of the Singapore Government',
        contactEmail: 'contact-us@agency.gov.sg',
      }
      create.mockResolvedValue(storableUrl)
      await expect(
        repository.create({ userId, shortUrl }, file),
      ).resolves.toStrictEqual(storableUrl)
      expect(create).toHaveBeenCalledWith(
        {
          longUrl: fileBucket.buildFileLongUrl(file.key),
          shortUrl,
          userId,
          isFile: true,
        },
        expect.anything(),
      )
      expect(putObject).toHaveBeenCalledWith({
        ContentType: file.mimetype,
        Bucket: s3Bucket,
        Body: file.data,
        Key: file.key,
        ACL: FileVisibility.Public,
        CacheControl: 'no-cache',
      })
    })
  })

  describe('update', () => {
    const findOne = jest.spyOn(urlModelMock, 'findOne')
    const putObject = jest.spyOn(s3Client, 'putObject')
    const putObjectAcl = jest.spyOn(s3Client, 'putObjectAcl')

    const shortUrl = 'abcdef'

    beforeEach(() => {
      findOne.mockReset()
      putObject.mockClear()
      putObjectAcl.mockClear()
    })

    afterAll(() => {
      findOne.mockRestore()
    })

    // @ts-ignore
    putObject.mockReturnValue({ promise: () => Promise.resolve() })
    // @ts-ignore
    putObjectAcl.mockReturnValue({ promise: () => Promise.resolve() })

    it('should throw NotFoundError on not found', async () => {
      findOne.mockResolvedValue(null)
      await expect(repository.update({ shortUrl }, {})).rejects.toBeInstanceOf(
        NotFoundError,
      )
      expect(findOne).toHaveBeenCalledWith({ where: { shortUrl } })
      expect(putObject).not.toHaveBeenCalled()
      expect(putObjectAcl).not.toHaveBeenCalled()
    })

    it('should update non-file links', async () => {
      const description = 'Changes made'
      const update = jest.fn()
      findOne.mockResolvedValue({ isFile: false, update })
      await expect(
        repository.update({ shortUrl }, { description }),
      ).resolves.toStrictEqual(expect.objectContaining({ isFile: false }))
      expect(findOne).toHaveBeenCalledWith({ where: { shortUrl } })
      expect(putObject).not.toHaveBeenCalled()
      expect(putObjectAcl).not.toHaveBeenCalled()
      expect(update).toHaveBeenCalledWith({ description }, expect.anything())
    })

    it('should update non-state changes on file links', async () => {
      const description = 'Changes made'
      const longUrl = 'https://files.go.gov.sg/key'
      const update = jest.fn()
      findOne.mockResolvedValue({ isFile: true, longUrl, update })
      await expect(
        repository.update({ shortUrl }, { description }),
      ).resolves.toStrictEqual(
        expect.objectContaining({ isFile: true, longUrl }),
      )
      expect(findOne).toHaveBeenCalledWith({ where: { shortUrl } })
      expect(putObject).not.toHaveBeenCalled()
      expect(putObjectAcl).not.toHaveBeenCalled()
      expect(update).toHaveBeenCalledWith({ description }, expect.anything())
    })

    it('should update state change to Active on file links', async () => {
      const state = StorableUrlState.Active
      const longUrl = 'https://files.go.gov.sg/key'
      const update = jest.fn()
      findOne.mockResolvedValue({ isFile: true, longUrl, update })
      await expect(
        repository.update({ shortUrl }, { state }),
      ).resolves.toStrictEqual(
        expect.objectContaining({ isFile: true, longUrl }),
      )
      expect(findOne).toHaveBeenCalledWith({ where: { shortUrl } })
      expect(putObject).not.toHaveBeenCalled()
      expect(update).toHaveBeenCalledWith({ state }, expect.anything())

      expect(putObjectAcl).toHaveBeenCalledWith({
        Bucket: s3Bucket,
        Key: fileBucket.getKeyFromLongUrl(longUrl),
        ACL: FileVisibility.Public,
      })
    })

    it('should update state change to Inactive on file links', async () => {
      const state = StorableUrlState.Inactive
      const longUrl = 'https://files.go.gov.sg/key'
      const update = jest.fn()
      findOne.mockResolvedValue({ isFile: true, longUrl, update })
      await expect(
        repository.update({ shortUrl }, { state }),
      ).resolves.toStrictEqual(
        expect.objectContaining({ isFile: true, longUrl }),
      )
      expect(findOne).toHaveBeenCalledWith({ where: { shortUrl } })
      expect(putObject).not.toHaveBeenCalled()
      expect(update).toHaveBeenCalledWith({ state }, expect.anything())

      expect(putObjectAcl).toHaveBeenCalledWith({
        Bucket: s3Bucket,
        Key: fileBucket.getKeyFromLongUrl(longUrl),
        ACL: FileVisibility.Private,
      })
    })

    it('should update file content for file links', async () => {
      const oldKey = 'old-key'
      const newKey = 'new-key'
      const longUrl = fileBucket.buildFileLongUrl(oldKey)
      const newLongUrl = fileBucket.buildFileLongUrl(newKey)

      const file = {
        key: newKey,
        data: Buffer.from(''),
        mimetype: 'text/csv',
      }

      const update = jest.fn()
      findOne.mockResolvedValue({ isFile: true, longUrl, update })

      await expect(
        repository.update({ shortUrl }, {}, file),
      ).resolves.toStrictEqual(
        expect.objectContaining({ isFile: true, longUrl }),
      )
      expect(findOne).toHaveBeenCalledWith({ where: { shortUrl } })

      expect(update).toHaveBeenCalledWith(
        { longUrl: newLongUrl },
        expect.anything(),
      )
      expect(putObjectAcl).toHaveBeenCalledWith({
        Bucket: s3Bucket,
        Key: oldKey,
        ACL: FileVisibility.Private,
      })
      expect(putObject).toHaveBeenCalledWith({
        ContentType: file.mimetype,
        Bucket: s3Bucket,
        Body: file.data,
        Key: file.key,
        ACL: FileVisibility.Public,
        CacheControl: 'no-cache',
      })
    })
  })

  describe('getLongUrl', () => {
    it('should return from db when cache is empty', async () => {
      await expect(repository.getLongUrl('a')).resolves.toBe('aa')
    })

    it('should return from cache when cache is filled', async () => {
      redisMockClient.set('a', 'aaa')
      await expect(repository.getLongUrl('a')).resolves.toBe('aaa')
    })

    it('should return from db when cache is down', async () => {
      cacheGetSpy.mockImplementationOnce((_, callback) => {
        if (!callback) {
          return false
        }
        callback(new Error('Cache down'), 'Error')
        return false
      })
      await expect(repository.getLongUrl('a')).resolves.toBe('aa')
    })
  })

  describe('rawDirectorySearch', () => {
    beforeEach(() => {
      mockQuery.mockClear()
    })
    it('should call sequelize.query that searches for emails', async () => {
      const conditions: DirectoryQueryConditions = {
        query: '@test.gov.sg @test2.gov.sg',
        order: SearchResultsSortOrder.Recency,
        limit: 100,
        offset: 0,
        state: 'ACTIVE',
        isFile: true,
        isEmail: true,
      }

      const repoawait = await repository.rawDirectorySearch(conditions)

      expect(repoawait).toStrictEqual({
        count: 1,
        urls: [
          {
            shortUrl: 'a',
            email: 'a@test.gov.sg',
            isFile: false,
            state: 'ACTIVE',
          },
        ],
      })
    })

    it('should call sequelize.query that searches with plain text', async () => {
      const conditions: DirectoryQueryConditions = {
        query: 'query',
        order: SearchResultsSortOrder.Recency,
        limit: 100,
        offset: 0,
        state: 'ACTIVE',
        isFile: true,
        isEmail: false,
      }

      const repoawait = await repository.rawDirectorySearch(conditions)
      expect(repoawait).toStrictEqual({
        count: 1,
        urls: [
          {
            email: 'test@test.gov.sg',
            shortUrl: 'a',
            state: 'ACTIVE',
            isFile: false,
          },
        ],
      })
    })
  })
})
