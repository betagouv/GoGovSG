import { inject, injectable } from 'inversify'
import { NotFoundError } from '../../../util/error'
import { JobItemRepositoryInterface } from '../../../repositories/interfaces/JobItemRepositoryInterface'
import { JobRepositoryInterface } from '../../../repositories/interfaces/JobRepositoryInterface'
import { DependencyIds } from '../../../constants'
import JobManagementServiceInterface from '../interfaces/JobManagementService'
import { StorableJob, StorableJobItem } from '../../../repositories/types'
import { JobItemStatusEnum, JobTypeEnum } from '../../../repositories/enums'
import { UserRepositoryInterface } from '../../../repositories/interfaces/UserRepositoryInterface'

@injectable()
class JobManagementService implements JobManagementServiceInterface {
  private jobRepository: JobRepositoryInterface

  private jobItemRepository: JobItemRepositoryInterface

  private userRepository: UserRepositoryInterface

  constructor(
    @inject(DependencyIds.jobRepository) jobRepository: JobRepositoryInterface,
    @inject(DependencyIds.jobItemRepository)
    jobItemRepository: JobItemRepositoryInterface,
    @inject(DependencyIds.userRepository)
    userRepository: UserRepositoryInterface,
  ) {
    this.jobRepository = jobRepository
    this.jobItemRepository = jobItemRepository
    this.userRepository = userRepository
  }

  createJob: (userId: number) => Promise<StorableJob> = async (userId) => {
    const user = await this.userRepository.findById(userId)
    if (!user) {
      throw new NotFoundError('User not found')
    }

    const job = await this.jobRepository.create(userId)
    return job
  }

  findJobById: (id: number) => Promise<StorableJob | null> = async (id) => {
    const job = await this.jobRepository.findById(id)
    return job
  }

  createJobItem: (properties: {
    status: JobItemStatusEnum
    message: string
    type: JobTypeEnum
    params: JSON
    jobId: number
  }) => Promise<StorableJobItem> = async (properties) => {
    const jobItem = await this.jobItemRepository.create(properties)
    return jobItem
  }

  updateJobItem: (
    jobItem: StorableJobItem,
    changes: Partial<StorableJobItem>,
  ) => Promise<StorableJobItem> = async (jobItem, changes) => {
    const updatedItem = await this.jobItemRepository.update(jobItem, changes)
    return updatedItem
  }

  findJobItemsByJobId: (jobId: number) => Promise<StorableJobItem[]> = async (
    jobId,
  ) => {
    const job = await this.jobRepository.findById(jobId)
    if (!job) {
      throw new NotFoundError('Job not found')
    }

    const jobItems = await this.jobItemRepository.findJobItemsByJobId(jobId)

    return jobItems
  }

  // 'success' when all related job items are also successful
  // 'failed' if at least one of them job item failed
  // 'in progress' if at least one of the job item is in progress (while the rest are either in progress or successful)
  getJobStatus: (jobId: number) => Promise<JobItemStatusEnum> = async (
    jobId,
  ) => {
    const jobItems = await this.findJobItemsByJobId(jobId)

    if (jobItems.length === 0) {
      throw new Error('Job does not have any job items')
    }

    let isInProgress = false

    for (let i = 0; i < jobItems.length; i += 1) {
      const { status } = jobItems[i]
      if (status === JobItemStatusEnum.Failed) {
        return JobItemStatusEnum.Failed
      }
      if (status === JobItemStatusEnum.InProgress) {
        isInProgress = true
      }
    }

    if (isInProgress) {
      return JobItemStatusEnum.InProgress
    }
    return JobItemStatusEnum.Success
  }
}

export default JobManagementService
